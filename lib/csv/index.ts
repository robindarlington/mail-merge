/**
 * lib/csv — the CSV upload/parse/persist subsystem barrel.
 *
 * Re-exports the shared upload guards (client resolver + server parse), the
 * traversal-proof storage writer, and the typed action-result contract, so
 * consumers import from `@/lib/csv` instead of reaching into individual modules
 * (mirrors lib/smtp/index.ts).
 *
 * NOTE: the two Server Actions themselves (`parseUploadedCsv` /
 * `saveRecipientSet`) are NOT re-exported here — a runtime re-export through a
 * barrel that non-server code imports would drag the "use server" module into a
 * client bundle. The UI imports the actions directly from `@/lib/csv/actions`;
 * this barrel exposes only the pure helpers and the (erased) types.
 */

export {
  uploadFileSchema,
  confirmColumnSchema,
  MAX_UPLOAD_BYTES,
  MAX_ROWS,
} from "./schema";
export type { UploadFile, ConfirmColumnValues } from "./schema";

export { writeUpload } from "./storage";

export type {
  ParseSummary,
  ParseResult,
  SaveResult,
  ActionError,
} from "./actions-core";
