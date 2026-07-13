/**
 * lib/campaign — the test-send + confirmation-gate subsystem barrel.
 *
 * Re-exports the shared campaign validators + tuning constants (client resolver +
 * server) and the typed action-result contract, so consumers import from
 * `@/lib/campaign` instead of reaching into individual modules (mirrors
 * lib/compose/index.ts).
 *
 * NOTE: the Server Action itself (`sendTestBatchChunk`) is NOT re-exported here —
 * a runtime re-export through a barrel that non-server code imports would drag the
 * "use server" module into a client bundle. The UI imports the action directly
 * from `@/lib/campaign/actions`; this barrel exposes only the shared schema /
 * constants and the (erased) types.
 */

export {
  campaignIdSchema,
  recipientSetIdSchema,
  templateIdSchema,
  chunkOffsetSchema,
  testAddressSchema,
  TEST_SEND_DELAY_MS,
  TEST_SEND_CHUNK_SIZE,
} from "./schema";

export type {
  ActionError,
  TestSendData,
  TestSendResult,
} from "./actions-core";
