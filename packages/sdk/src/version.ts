/**
 * The API release this SDK's types describe, sent as `Ingot-Version` on every
 * request.
 *
 * The last entry in `RELEASES` in `apps/ingot/src/versioning/changeset.ts`.
 * A request without the header gets the newest shape, so an SDK that sent none
 * would break the day the server released a new one; pinning it means an
 * upgraded server keeps answering in the shape these types promise. Bump it
 * together with the types.
 */
export const INGOT_API_VERSION = '2026-09-17';

export const SDK_VERSION = '0.2.0';
