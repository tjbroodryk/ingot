/** The few ways the dashboard turns a number into words. */

/** `3 tables`, `1 table`. */
export function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

/** A byte count at the unit a person reads it in. */
export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How long a memory has left, in the largest unit that is still a whole number
 * of something — `14d left`, `30m left`.
 *
 * Read off the clock of whoever is looking, which is the one it matters to. A
 * value that does not parse is printed as it came rather than guessed at.
 */
export function timeLeft(expiresAt: string, now: number = Date.now()): string {
  const remaining = Date.parse(expiresAt) - now;
  if (Number.isNaN(remaining)) return expiresAt;
  if (remaining <= 0) return 'expired';

  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m left`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h left`;

  const days = Math.floor(hours / 24);
  if (days < 28) return `${days}d left`;

  return `${Math.floor(days / 7)}w left`;
}
