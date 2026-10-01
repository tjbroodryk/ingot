import { isDeepStrictEqual } from 'node:util';
import type { Env } from '../../src/config/env.js';
import type {
  AnalyticalEngine,
  CompactionOutcome,
  CompactionRequest,
  MaterialisableTable,
  QueryOutcome,
  QueryRequest,
} from '../../src/engine/analytical-engine.port.js';
import { DuckDbEngine } from '../../src/engine/duckdb-engine.js';
import type { ParquetCache } from '../../src/engine/parquet-cache.js';
import type { ObjectStore } from '../../src/storage/object-store.port.js';

/** One side of a comparison: what came back, or what it threw. */
type Answer<T> = { ok: T } | { refused: string; error: unknown };

export class ParityMismatch extends Error {}

/**
 * Two engines over the same tiers, one reading Parquet through views and one
 * copying it in, with every query asked of both. Any difference throws
 * `ParityMismatch`; otherwise the views engine's answer is returned.
 *
 * Roll-ups go to the copying engine only: they never use views.
 */
export class ParityEngine implements AnalyticalEngine {
  readonly views: DuckDbEngine;
  readonly copies: DuckDbEngine;
  /** Statements compared so far, so a suite can show it compared something. */
  compared = 0;

  constructor(store: ObjectStore, env: Env, cache: ParquetCache) {
    this.views = new DuckDbEngine(store, { ...env.engine, views: true }, cache);
    this.copies = new DuckDbEngine(store, { ...env.engine, views: false }, cache);
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.views.onModuleInit(), this.copies.onModuleInit()]);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.views.onModuleDestroy(), this.copies.onModuleDestroy()]);
  }

  tablesNamedBy(sql: string): Promise<readonly string[] | null> {
    return this.copies.tablesNamedBy(sql);
  }

  compact(request: CompactionRequest): Promise<CompactionOutcome> {
    return this.copies.compact(request);
  }

  async run(request: QueryRequest): Promise<QueryOutcome> {
    const strip = ({ elapsedMs: _, ...rest }: QueryOutcome) => rest;
    return this.compare(request.sql, (engine) => engine.run(request), strip);
  }

  async resolveRows(request: {
    table: MaterialisableTable;
    where: string;
    cap: number;
    timeoutMs: number;
  }): Promise<{ rowIds: readonly string[]; truncated: boolean }> {
    // Unordered, so compared as a set; under the cap every match is in it.
    return this.compare(
      `DELETE … WHERE ${request.where}`,
      (engine) => engine.resolveRows(request),
      (found) => ({ ...found, rowIds: [...found.rowIds].sort() }),
    );
  }

  private async compare<T>(
    label: string,
    ask: (engine: DuckDbEngine) => Promise<T>,
    comparable: (answer: T) => unknown,
  ): Promise<T> {
    const settle = (engine: DuckDbEngine): Promise<Answer<T>> =>
      ask(engine).then(
        (ok) => ({ ok }),
        (error: unknown) => ({
          refused: error instanceof Error ? error.message : String(error),
          error,
        }),
      );
    const viewed = await settle(this.views);
    const copied = await settle(this.copies);
    this.compared += 1;

    const shape = (answer: Answer<T>) =>
      'ok' in answer ? { ok: comparable(answer.ok) } : { refused: answer.refused };
    if (!isDeepStrictEqual(shape(viewed), shape(copied))) {
      throw new ParityMismatch(
        `A view and a copy disagree on: ${label}\n` +
          `view: ${JSON.stringify(shape(viewed), bigints)}\n` +
          `copy: ${JSON.stringify(shape(copied), bigints)}`,
      );
    }
    if ('refused' in viewed) throw viewed.error;
    return viewed.ok;
  }
}

function bigints(_: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}
