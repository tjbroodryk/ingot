import { InvariantViolation } from '../../../../shared/domain/index.js';
import type {
  DocumentParser,
  ParsedDocument,
} from '../../application/ports/document-parser.port.js';
import type { MediaType } from '../../domain/media-type.js';

/**
 * The parsers this build has, behind one port.
 *
 * A composite rather than a selector, because these are not alternatives the
 * way `local` and `openai` are alternatives for an embedder — they are three
 * disjoint capabilities, and a deployment wants all of the ones it has. There
 * is nothing here for an operator to choose, which is why there is no
 * `INGOT_PARSER`: what this build reads is a property of the build.
 *
 * `handles` is the union, so `AcceptFile` refuses a format nobody here reads at
 * the door — naming what is available — rather than storing the bytes, queueing
 * the work and abandoning it four attempts later.
 *
 * Two parsers claiming one media type is refused at construction. It would
 * otherwise resolve by insertion order, which is a coin-flip nobody wrote down:
 * both would look registered, one would silently never run, and the symptom
 * would be a format that parses differently depending on a line's position in a
 * module.
 */
export class RoutingParser implements DocumentParser {
  readonly name: string;
  readonly handles: ReadonlySet<MediaType>;

  private readonly routes = new Map<MediaType, DocumentParser>();

  constructor(parsers: readonly DocumentParser[]) {
    for (const parser of parsers) {
      for (const type of parser.handles) {
        const existing = this.routes.get(type);
        if (existing) {
          throw new InvariantViolation(
            `Both the "${existing.name}" and "${parser.name}" parsers claim ${type}. ` +
              'One media type is read by one parser, or which one runs depends on the order ' +
              'they were listed in.',
          );
        }
        this.routes.set(type, parser);
      }
    }

    this.name = parsers.map((parser) => parser.name).join('+');
    this.handles = new Set(this.routes.keys());
  }

  parse(input: {
    content: Buffer;
    mediaType: MediaType;
    filename: string;
  }): Promise<ParsedDocument> {
    const parser = this.routes.get(input.mediaType);
    if (!parser) {
      // Unreachable through `/file`, which checks `handles` before storing
      // anything. Kept because this class is also the thing a future parser is
      // registered with, and "silently produced no blocks" is a much worse way
      // to find out a registration was missed.
      throw new InvariantViolation(
        `No parser in this build reads ${input.mediaType}. It reads: ` +
          `${[...this.handles].join(', ')}.`,
      );
    }
    return parser.parse(input);
  }

  /** What each parser reads, for the line at boot. */
  describe(): string {
    const byParser = new Map<string, MediaType[]>();
    for (const [type, parser] of this.routes) {
      byParser.set(parser.name, [...(byParser.get(parser.name) ?? []), type]);
    }

    return [...byParser]
      .map(([name, types]) => `${name} (${types.join(', ')})`)
      .join(', ');
  }
}
