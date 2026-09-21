import { z } from 'zod';

/**
 * The pieces every section of `Env` is declared with.
 *
 * Each one treats blank as unset — a variable exported as `""` is a deployment
 * template left blank, not a value — and trims what it keeps.
 *
 * Messages come in two kinds, and `loadEnv` tells them apart by the first
 * character. One starting `;` or `,` is a clause about the value, and the boot
 * error prefixes it with `NAME is "value"`, so the operator sees what they
 * actually set. Anything else is a whole sentence and is printed as written —
 * which is what a message about a secret has to be.
 */

export type Ctx = z.RefinementCtx;

function blank(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** An optional string. */
export function text() {
  return z.preprocess(blank, z.string().optional());
}

/** A string with a default. */
export function textOr(fallback: string) {
  return text().transform((raw) => raw ?? fallback);
}

/**
 * A whole number within bounds, or `fallback` when unset.
 *
 * `Number` rather than `parseInt`: Helm renders large integers as `3.3e+07`,
 * and `parseInt` reads that as 3.
 */
export function whole(options: {
  readonly fallback: number;
  readonly min: number;
  readonly max?: number;
  readonly rule?: string;
}) {
  const { fallback, min, max } = options;
  const rule =
    options.rule ??
    (max === undefined
      ? `; it must be a whole number, at least ${min}.`
      : `; it must be a whole number between ${min} and ${max}.`);

  return text().transform((raw, ctx) => {
    if (raw === undefined) return fallback;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      ctx.addIssue(rule);
      return z.NEVER;
    }
    return parsed;
  });
}

/** One of `values`, case-insensitively, or undefined when unset. */
export function choice<const T extends string>(values: readonly T[], rule: string) {
  return text().transform((raw, ctx) => {
    if (raw === undefined) return undefined;

    const lowered = raw.toLowerCase();
    const found = values.find((value) => value === lowered);
    if (found === undefined) {
      ctx.addIssue(rule);
      return z.NEVER;
    }
    return found;
  });
}

/**
 * Every value a selector cannot work without, or one issue naming all of the
 * ones that are missing.
 *
 * All at once rather than the first: an operator filling in a deployment
 * template should learn what is left in one restart, not in three.
 */
export function demand<const K extends readonly string[]>(
  ctx: Ctx,
  vars: Readonly<Record<string, unknown>>,
  selected: string,
  keys: K,
  hint = '',
): { [I in keyof K]: string } | undefined {
  const found = keys.map((key) => vars[key]);
  const missing = keys.filter((_key, at) => typeof found[at] !== 'string');

  if (missing.length > 0) {
    ctx.addIssue(`${selected} needs ${keys.join(', ')}. Missing: ${missing.join(', ')}.${hint}`);
    return undefined;
  }
  // Every element was just proved present, which is a fact about the loop
  // above rather than one the type of `map` can carry.
  return found as { [I in keyof K]: string };
}

/**
 * A group of variables and the settings built from them.
 *
 * The shape declares each variable — optional, defaulted, bounded — and
 * `build` handles what one variable cannot say on its own: a selector that
 * needs others set, two values checked against each other. `build` reports
 * through `ctx` rather than throwing, so every problem in the environment
 * reaches the one boot error together.
 */
export function section<const S extends z.ZodRawShape, T>(
  vars: S,
  build: (vars: VarsOf<S>, ctx: Ctx) => T,
) {
  return z.object(vars).transform(build);
}

/** The parsed values of a shape of variables. */
export type VarsOf<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

/** Any section, as `loadEnv` sees it: the variables it declares and what it builds. */
export interface Section<T = unknown> {
  readonly in: z.ZodObject;
  safeParse(source: unknown): z.ZodSafeParseResult<T>;
}
