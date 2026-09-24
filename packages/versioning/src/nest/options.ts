import type { Changeset } from '../changeset.js';

export const VERSIONING_OPTIONS = Symbol('VersioningOptions');

export interface VersioningOptions {
  /** The published versions of this service. */
  readonly changeset: Changeset;
  /**
   * The header a caller names a version in and the service answers with —
   * `Ingot-Version`, say. Branded rather than a generic `Api-Version` so a
   * proxy juggling several APIs never confuses them.
   */
  readonly header: string;
}
