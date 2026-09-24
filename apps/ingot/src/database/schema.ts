/** Every table in the service, re-exported from the context that owns it. */
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
