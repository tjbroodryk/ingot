import type { Changeset } from '../changeset.js';

export const VERSIONING_OPTIONS = Symbol('VersioningOptions');

export interface VersioningOptions {
  /** The published versions of this service. */
  readonly changeset: Changeset;
  /**
   * The request header a caller names a version in, and the response header
   * this service answers with — `Ingot-Version`, `Forge-Version`.
   *
   * Branded rather than a generic `Api-Version` for the reason Stripe brands
   * theirs: a proxy or a client library juggling several APIs should not have
   * one header meaning different things depending on where the request landed.
   */
  readonly header: string;
}
