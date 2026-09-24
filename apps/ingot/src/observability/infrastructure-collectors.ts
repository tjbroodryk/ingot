import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type pg from 'pg';
import { DATABASE_POOL } from '../database/database.module.js';
import { Metrics, PoolState } from './metrics/catalogue.js';

/**
 * Reads the Postgres pool gauges at scrape time rather than tracking them.
 *
 * `waiting` above zero means requests are queued on a connection; it moves
 * before latency does. Other read-at-scrape gauges are registered by the
 * context that owns the table they count.
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
