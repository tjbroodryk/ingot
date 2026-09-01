/**
 * Value objects are compared by their contents, never by identity, and are
 * frozen on construction so sharing one is always safe.
 */
export abstract class ValueObject {
  protected constructor() {
    // Subclasses call `seal()` once their fields are assigned.
  }

  protected seal(): void {
    Object.freeze(this);
  }

  equals(other: this | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    if (other === this) return true;
    if (other.constructor !== this.constructor) return false;
    return stableStringify(this) === stableStringify(other);
  }
}

/** Deterministic JSON — key order must not affect equality. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
