export {
  IngotFoundry,
  type CastIngotOptions,
  type IngotFoundryOptions,
  type VersionsResponse,
} from './client.js';
export {
  Ingot,
  Table,
  TypedTable,
  type AddOptions,
  type CloneIngotOptions,
  type DocumentRow,
  type ParquetOptions,
  type PendingOptions,
  type ReceiptRow,
  type Row,
  type SearchOptions,
  type SnapshotOptions,
  type TableSnapshot,
  type TypedQueryResult,
  type WaitOptions,
} from './ingot.js';
export {
  Column,
  TableDef,
  VarcharColumn,
  col,
  table,
  type AddableTable,
  type AnyColumn,
  type ColumnFactory,
  type ColumnSource,
  type ColumnValues,
  type EmbeddedColumns,
  type Infer,
  type SystemColumns,
  type TableMapping,
  type VarcharFactory,
} from './table.js';
export type { DocumentInput, UploadOptions } from './upload.js';
export { parseDelivery } from './delivery.js';
export type { IngotMcpTool, McpOptions } from './mcp.js';
export type { FetchLike } from './transport.js';
export {
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  ConnectionError,
  GoneError,
  IngotError,
  McpToolError,
  NotFoundError,
  PermissionError,
  TimeoutError,
  UnavailableError,
  UnknownDeliveryEventError,
  ValidationError,
} from './errors.js';
export { INGOT_API_VERSION, SDK_VERSION } from './version.js';
export * from './contract.js';
