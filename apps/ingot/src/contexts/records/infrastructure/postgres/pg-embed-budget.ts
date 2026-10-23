import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import { EMBEDDINGS_TPM } from '../../application/background-settings.js';
import type { EmbedBudget } from '../../application/ports/embed-budget.port.js';
import { embedBudget } from './schema.js';

const WINDOW = sql`interval '1 minute'`;

/** Each call is one upsert on the one row, so replicas never read-then-write past each other. */
@Injectable()
export class PgEmbedBudget implements EmbedBudget {
  constructor(
    private readonly uow: PgUnitOfWork,
    @Inject(EMBEDDINGS_TPM) private readonly tpm: number | null,
  ) {}

  async paused(now: Date): Promise<boolean> {
    const result = await this.uow.queryable.execute(sql`
      SELECT 1 FROM ${embedBudget} WHERE paused_until > ${now}
    `);
    return result.rows.length > 0;
  }

  async reserve(tokens: number, now: Date): Promise<boolean> {
    const result = await this.uow.queryable.execute(sql`
      INSERT INTO ${embedBudget} AS b (id, window_start, tokens_used)
      VALUES (true, ${now}, ${tokens})
      ON CONFLICT (id) DO UPDATE SET
        window_start = CASE WHEN b.window_start + ${WINDOW} <= ${now}
                            THEN ${now} ELSE b.window_start END,
        tokens_used  = CASE WHEN b.window_start + ${WINDOW} <= ${now}
                            THEN ${tokens} ELSE b.tokens_used + ${tokens} END
      WHERE (b.paused_until IS NULL OR b.paused_until <= ${now})
        AND (${this.tpm}::bigint IS NULL
             OR b.window_start + ${WINDOW} <= ${now}
             OR b.tokens_used = 0
             OR b.tokens_used + ${tokens} <= ${this.tpm}::bigint)
      RETURNING 1
    `);
    return result.rows.length > 0;
  }

  async pause(until: Date): Promise<void> {
    await this.uow.queryable.execute(sql`
      INSERT INTO ${embedBudget} AS b (id, window_start, tokens_used, paused_until)
      VALUES (true, '-infinity', 0, ${until})
      ON CONFLICT (id) DO UPDATE SET paused_until = GREATEST(b.paused_until, ${until})
    `);
  }
}
