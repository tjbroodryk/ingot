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

/** Cap on the FTS ignore pattern. */
const MAX_IGNORE = 200;

/**
 * How one table's text is indexed and searched — the arguments to
 * `PRAGMA create_fts_index`. Parsed here, not at the controller: a non-`english`
 * `stopwords` is read by DuckDB as a table name, so the enums are the boundary.
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

  /** The default: search off. */
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

  /** This, with a caller's patch applied. Absent fields keep their current value. */
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
      // Parsed as identifiers: they are spliced into the index pragma.
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

/** Everything configurable about one table, as the manifest holds it. */
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
