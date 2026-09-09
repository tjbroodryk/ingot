/**
 * Every table in the service, re-exported from the context that owns it.
 *
 * Tables live beside the code that maps them — `accounts` owns `account`,
 * `records` owns the overlay — so adding a context means adding a line here
 * rather than moving a file. Drizzle needs one place to look; this is it, and
 * `schema-drift.test.ts` walks it against what Postgres actually has.
 */
export { account, accountKey } from '../contexts/accounts/infrastructure/postgres/schema.js';
export { fileQueue } from '../contexts/files/infrastructure/postgres/schema.js';
export { ingot, ingotTable } from '../contexts/ingots/infrastructure/postgres/schema.js';
export {
  overlayReceiptQueue,
  overlayEmbedQueue,
  overlayRow,
  overlayTombstone,
  overlayVector,
  receiptDeliveryQueue,
} from '../contexts/records/infrastructure/postgres/schema.js';
