import {
  type ConfigureTableBody,
  type FtsConfig,
  FtsStemmer,
  FtsStopwords,
  type TableConfig as WireTableConfig,
} from '@ingot/shared/ingot-v1';
import { Guard, ValueObject } from '../../../shared/domain/index.js';
import { SqlName } from './sql-name.vo.js';

/** DuckDB's own defaults, which is what an unconfigured table gets. */
const DEFAULT_IGNORE = '(\\.|[^a-z])+';

/** Long enough for a real character class, short enough not to be a payload. */
const MAX_IGNORE = 200;

/**
 * How one table's text is indexed and searched.
 *
 * These are the arguments `PRAGMA create_fts_index` takes. They live on the
 * table rather than on the query because the analysis has to match at both
 * ends: an index built with the English stopword list, searched by a term that
 * kept its stopwords, ranks on tokens the index does not contain. One place to
 * set them is what makes the two halves the same by construction.
 *
 * Every field is parsed here rather than at the controller, and the two enums
 * are why. `stemmer` is refused by DuckDB if it is not one of Snowball's, so a
 * bad one is merely an ugly error — but `stopwords` is read as *the name of a
 * table* when it is not `english`, so an unparsed string is a caller naming a
 * table for this service to read. `Guard.oneOf` over `Object.values` is the
 * boundary, and it is the reason both are enums rather than strings.
 */
export class FtsSettings extends ValueObject {
  readonly enabled: boolean;
  readonly stemmer: FtsStemmer;
  readonly stopwords: FtsStopwords;
  readonly ignore: string;
  readonly stripAccents: boolean;
  readonly lowercase: boolean;
  /** Empty means every VARCHAR column, resolved when the index is built. */
  readonly columns: readonly string[];

  private constructor(props: {
    enabled: boolean;
    stemmer: FtsStemmer;
    stopwords: FtsStopwords;
    ignore: string;
    stripAccents: boolean;
    lowercase: boolean;
    columns: readonly string[];
  }) {
    super();
    this.enabled = props.enabled;
    this.stemmer = props.stemmer;
    this.stopwords = props.stopwords;
    this.ignore = props.ignore;
    this.stripAccents = props.stripAccents;
    this.lowercase = props.lowercase;
    this.columns = [...props.columns];
    this.seal();
  }

  /**
   * What a table gets before anybody configures it: off.
   *
   * Off rather than on because an index is built per session over the whole
   * table, so switching it on for every table would put that cost on every
   * query of every memory, including the ones storing no prose at all. A
   * caller who wants search says so once.
   */
  static default(): FtsSettings {
    return new FtsSettings({
      enabled: false,
      stemmer: FtsStemmer.Porter,
      stopwords: FtsStopwords.English,
      ignore: DEFAULT_IGNORE,
      stripAccents: true,
      lowercase: true,
      columns: [],
    });
  }

  /**
   * This, with a caller's patch applied.
   *
   * Absent fields keep what is already set. A config endpoint where omitting
   * `stemmer` silently reset it is one that cannot be called twice safely —
   * the second call, sent to change one thing, quietly undoes the first.
   */
  patched(patch: Partial<FtsConfig> | undefined): FtsSettings {
    if (!patch) return this;

    return new FtsSettings({
      enabled: patch.enabled ?? this.enabled,
      stemmer:
        patch.stemmer === undefined
          ? this.stemmer
          : Guard.oneOf(
              String(patch.stemmer).toLowerCase(),
              Object.values(FtsStemmer),
              'fts.stemmer',
            ),
      stopwords:
        patch.stopwords === undefined
          ? this.stopwords
          : Guard.oneOf(
              String(patch.stopwords).toLowerCase(),
              Object.values(FtsStopwords),
              'fts.stopwords',
            ),
      ignore:
        patch.ignore === undefined
          ? this.ignore
          : Guard.maxLength(String(patch.ignore), MAX_IGNORE, 'fts.ignore'),
      stripAccents: patch.stripAccents ?? this.stripAccents,
      lowercase: patch.lowercase ?? this.lowercase,
      // Parsed as identifiers, not merely lowercased: these are spliced into
      // the pragma that builds the index, and `SqlName` is the character-set
      // boundary the rest of this service already trusts for that.
      columns:
        patch.columns === undefined
          ? this.columns
          : patch.columns.map((column) => SqlName.column(String(column)).value),
    });
  }

  /** Rehydration from the manifest — the same parsing, off a stored document. */
  static rehydrate(stored: Partial<FtsConfig>): FtsSettings {
    return FtsSettings.default().patched(stored);
  }

  toWire(): FtsConfig {
    return {
      enabled: this.enabled,
      stemmer: this.stemmer,
      stopwords: this.stopwords,
      ignore: this.ignore,
      stripAccents: this.stripAccents,
      lowercase: this.lowercase,
      columns: [...this.columns],
    };
  }
}

/**
 * Everything configurable about one table, as the manifest holds it.
 *
 * An envelope around a single member so that the next kind of setting is a
 * field rather than a second column, a second endpoint and a second migration.
 */
export class TableConfig extends ValueObject {
  readonly fts: FtsSettings;

  private constructor(fts: FtsSettings) {
    super();
    this.fts = fts;
    this.seal();
  }

  static default(): TableConfig {
    return new TableConfig(FtsSettings.default());
  }

  static rehydrate(stored: { fts?: Partial<FtsConfig> } | null | undefined): TableConfig {
    return new TableConfig(FtsSettings.rehydrate(stored?.fts ?? {}));
  }

  patched(patch: ConfigureTableBody): TableConfig {
    return new TableConfig(this.fts.patched(patch.fts));
  }

  toWire(): WireTableConfig {
    return { fts: this.fts.toWire() };
  }
}
