import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type pg from 'pg';
import { DATABASE_POOL } from '../database/database.module.js';
import { Metrics, PoolState } from './metrics/catalogue.js';

/**
 * The numbers that are read rather than counted.
 *
 * A gauge maintained by increments is a gauge that drifts: one path that
 * returns early without decrementing, one exception between the two, and the
 * value is wrong in a way nothing will ever correct — and wrong plausibly,
 * which is the worst kind. The pool has somewhere authoritative to read from
 * at scrape time, so it is read.
 *
 * It is also the earliest warning this service has. `waiting` above zero means
 * requests are queued on a connection rather than on Postgres, and it moves
 * well before latency does.
 *
 * The other read-at-scrape gauges — overlay depth, embeddings pending — are
 * registered by the context that owns the table they count, so that this file
 * does not have to know what an overlay is.
 */
@Injectable()
export class InfrastructureCollectors implements OnApplicationBootstrap {
  constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {}

  onApplicationBootstrap(): void {
    Metrics.DbPoolConnections.collectWith((gauge) => {
      gauge.set({ state: PoolState.Total }, this.pool.totalCount);
      gauge.set({ state: PoolState.Idle }, this.pool.idleCount);
      gauge.set({ state: PoolState.Waiting }, this.pool.waitingCount);
    });
  }
}
