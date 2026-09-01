import type { Payload, Release, ShapeChange } from './change.js';
import { MalformedChangeset, UnknownVersion } from './errors.js';
import { compareVersions, isVersionId, type VersionId } from './version.js';

type Transform = (value: Payload) => Payload;

interface Chains {
  readonly forward: readonly Transform[];
  readonly backward: readonly Transform[];
}

/**
 * The published versions of one API, and how to move between them.
 *
 * The model, which is Stripe's: **only the newest shape is ever implemented.**
 * Handlers, DTOs and the wire contract describe it and nothing else. An older
 * version is not a second implementation — it is the current one with a stack
 * of small transformations in front of it, applied on the way in and unapplied
 * on the way out.
 *
 * That is what stops versioning becoming a tax on every future change. Adding
 * a version costs one file describing what moved; it does not cost a branch
 * inside a handler, and it does not cost a second set of tests, because the
 * only behaviour under test is the newest one plus a pile of pure functions.
 *
 * Serving a caller pinned to `v`:
 *
 * ```
 *   request   →  forward transforms of every release AFTER v, oldest first
 *   handler      (sees the current shape, always)
 *   response  →  backward transforms of every release AFTER v, newest first
 * ```
 *
 * A release describes what it *changed*, so a caller already on that version
 * sees the new shape — which is why the chains start strictly after `v` rather
 * than at it.
 */
export class Changeset<V extends string = VersionId> {
  readonly versions: readonly V[];
  readonly latest: V;
  readonly oldest: V;

  private readonly releases: readonly Release<V>[];
  /** version → shape → the chains to serve that version. Built once, at boot. */
  private readonly chains = new Map<V, Map<string, Chains>>();

  constructor(releases: readonly Release<V>[]) {
    assertWellFormed(releases);

    this.releases = releases;
    this.versions = releases.map((release) => release.version);
    this.oldest = this.versions[0] as V;
    this.latest = this.versions[this.versions.length - 1] as V;

    // Precomputed rather than assembled per request. There are few enough
    // versions that it would not matter either way, but a chain built once at
    // boot is a chain that cannot be built differently on the second call.
    for (const version of this.versions) this.chains.set(version, this.build(version));
  }

  has(candidate: string): candidate is V {
    return (this.versions as readonly string[]).includes(candidate);
  }

  /** The version a caller named, or `UnknownVersion` naming the alternatives. */
  parse(candidate: string): V {
    if (!this.has(candidate)) throw new UnknownVersion(candidate, this.versions);
    return candidate;
  }

  /** A caller's request, migrated up to the shape the handler implements. */
  forward(shape: string, value: Payload, from: V): Payload {
    return apply(this.chainFor(from, shape)?.forward, value);
  }

  /** The handler's response, rendered back down to the shape a caller expects. */
  backward(shape: string, value: Payload, to: V): Payload {
    return apply(this.chainFor(to, shape)?.backward, value);
  }

  /** True when serving `version` needs no work at all — the common case. */
  isCurrent(version: V): boolean {
    return version === this.latest;
  }

  /** Every shape any release touches. Used to check they are real shapes. */
  shapes(): readonly string[] {
    return [...new Set(this.releases.flatMap((r) => r.changes.map((c) => c.shape)))].sort();
  }

  /** For a `GET /versions` endpoint, newest first. */
  changelog(): readonly { version: V; summary: string; changes: readonly string[] }[] {
    return [...this.releases].reverse().map((release) => ({
      version: release.version,
      summary: release.summary,
      changes: release.changes.map((change) => `${change.shape}: ${change.note}`),
    }));
  }

  private chainFor(version: V, shape: string): Chains | undefined {
    return this.chains.get(version)?.get(shape);
  }

  private build(version: V): Map<string, Chains> {
    // Strictly after: a release describes what it changed, so a caller on that
    // version is already looking at the result of it.
    const later = this.releases.filter((release) => compareVersions(release.version, version) > 0);

    const byShape = new Map<string, { forward: Transform[]; backward: Transform[] }>();
    const chain = (shape: string) => {
      const existing = byShape.get(shape);
      if (existing) return existing;
      const created = { forward: [] as Transform[], backward: [] as Transform[] };
      byShape.set(shape, created);
      return created;
    };

    for (const release of later) {
      for (const change of release.changes) {
        if (change.forward) chain(change.shape).forward.push(change.forward);
      }
    }

    // Backward is the exact reverse of forward — releases newest first, and
    // within a release the changes in reverse declaration order. Two changes to
    // one shape in one release compose, and undoing them in the order they were
    // applied would undo the wrong one first.
    for (const release of [...later].reverse()) {
      for (const change of [...release.changes].reverse()) {
        if (change.backward) chain(change.shape).backward.push(change.backward);
      }
    }

    return new Map(
      [...byShape].map(([shape, built]) => [
        shape,
        { forward: built.forward, backward: built.backward },
      ]),
    );
  }
}

function apply(transforms: readonly Transform[] | undefined, value: Payload): Payload {
  if (!transforms || transforms.length === 0) return value;
  return transforms.reduce<Payload>((carried, transform) => transform(carried), value);
}

/**
 * Everything that would make a changeset dishonest, refused at construction.
 *
 * At boot rather than on the first request that happens to need the broken
 * part: a changeset out of order does not fail, it silently serves the wrong
 * shape, and that is the sort of thing discovered by a customer.
 */
function assertWellFormed(releases: readonly Release[]): void {
  if (releases.length === 0) {
    throw new MalformedChangeset('A changeset needs at least one release — the baseline.');
  }

  const seen = new Set<string>();
  let previous: string | null = null;

  for (const release of releases) {
    if (!isVersionId(release.version)) {
      throw new MalformedChangeset(
        `"${release.version}" is not a version. Use a real, zero-padded date: 2026-08-26.`,
      );
    }
    if (seen.has(release.version)) {
      throw new MalformedChangeset(`Version ${release.version} is declared twice.`);
    }
    if (previous !== null && compareVersions(release.version, previous) <= 0) {
      throw new MalformedChangeset(
        `Releases must be listed oldest first: ${release.version} follows ${previous}.`,
      );
    }
    if (release.summary.trim().length === 0) {
      throw new MalformedChangeset(`Version ${release.version} has no summary.`);
    }

    seen.add(release.version);
    previous = release.version;
    assertChangesAreUsable(release);
  }

  const [baseline] = releases;
  if (baseline && baseline.changes.length > 0) {
    throw new MalformedChangeset(
      `The oldest version (${baseline.version}) is the baseline and has nothing to ` +
        'transform to — its changes would never run. Move them to the release that introduced them.',
    );
  }
}

function assertChangesAreUsable(release: Release): void {
  for (const change of release.changes) {
    if (!change.forward && !change.backward) {
      throw new MalformedChangeset(
        `${release.version} declares a change to ${change.shape} that transforms nothing ` +
          'in either direction, so it would be invisible to every caller.',
      );
    }
    if (change.note.trim().length === 0) {
      throw new MalformedChangeset(
        `${release.version}'s change to ${change.shape} has no note saying what moved.`,
      );
    }
  }
}

export type { Payload, Release, ShapeChange };
