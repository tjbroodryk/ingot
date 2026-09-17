import { Inject, Injectable } from '@nestjs/common';
import {
  type Delivered,
  type DeliveredOperations,
  type DeliveredRollUp,
  type DeliveredTableDrop,
  DeliveryEvent,
} from '@ingot/shared/ingot-v1';
import { DELIVERY_SETTINGS, type DeliverySettings } from '../../../delivery/delivery-settings.js';
import type { Ingot } from '../../ingots/domain/index.js';
import type { ChangeNotifier } from '../application/ports/change-notifier.port.js';
import { DELIVERY_OUTBOX, type DeliveryOutbox } from '../application/ports/delivery-outbox.port.js';

type TableEvent = Exclude<Delivered, { event: DeliveryEvent.ReceiptReady }>;

/**
 * Announces table changes into the outbox, one waiting delivery per table and
 * event. See `DeliveryOutbox.announce` for the folding.
 */
@Injectable()
export class OutboxChangeNotifier implements ChangeNotifier {
  constructor(
    @Inject(DELIVERY_OUTBOX) private readonly outbox: DeliveryOutbox,
    @Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings,
  ) {}

  async appended(change: Parameters<ChangeNotifier['appended']>[0]): Promise<boolean> {
    // Checked before the watermark is read, which most writes never need.
    if (!change.ingot.delivery.wants(DeliveryEvent.OperationsAppended)) return false;

    const payload: DeliveredOperations = {
      event: DeliveryEvent.OperationsAppended,
      ingot: change.ingot.id.value,
      table: change.table,
      generation: change.generation,
      throughSeq: change.rows > 0 ? ((await change.throughSeq())?.toString() ?? null) : null,
      rows: change.rows,
      tombstones: change.tombstones,
      at: change.at.toISOString(),
      attempt: 1,
    };

    return this.announce(change.ingot, change.tableId, payload, (queued) => {
      const earlier = queued as DeliveredOperations;
      return {
        ...payload,
        throughSeq: laterSeq(earlier.throughSeq, payload.throughSeq),
        rows: earlier.rows + payload.rows,
        tombstones: earlier.tombstones + payload.tombstones,
      };
    });
  }

  rolledUp(change: Parameters<ChangeNotifier['rolledUp']>[0]): Promise<boolean> {
    const payload: DeliveredRollUp = {
      event: DeliveryEvent.TableRolledUp,
      ingot: change.ingot.id.value,
      table: change.table,
      generation: change.generation,
      previousGeneration: change.generation - 1,
      rows: change.rows,
      at: change.at.toISOString(),
      attempt: 1,
    };

    // Two roll-ups before a delivery are one: the receiver re-reads from the
    // newest, and wants to know how far back its own copy may be.
    return this.announce(change.ingot, change.tableId, payload, (queued) => ({
      ...payload,
      previousGeneration: (queued as DeliveredRollUp).previousGeneration,
    }));
  }

  dropped(change: Parameters<ChangeNotifier['dropped']>[0]): Promise<boolean> {
    const payload: DeliveredTableDrop = {
      event: DeliveryEvent.TableDropped,
      ingot: change.ingot.id.value,
      table: change.table,
      at: change.at.toISOString(),
      attempt: 1,
    };
    return this.announce(change.ingot, change.tableId, payload, () => payload);
  }

  private async announce(
    ingot: Ingot,
    tableId: string,
    payload: TableEvent,
    merge: (queued: Delivered) => Delivered,
  ): Promise<boolean> {
    if (!ingot.delivery.wants(payload.event)) return false;

    await this.outbox.announce({
      key: `${payload.event}:${tableId}`,
      ingotId: ingot.id.value,
      target: ingot.delivery.toWire(),
      payload,
      queuedAt: new Date(payload.at),
      maxAttempts: this.settings.maxAttempts,
      merge,
    });
    return true;
  }
}

function laterSeq(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return BigInt(left) > BigInt(right) ? left : right;
}
