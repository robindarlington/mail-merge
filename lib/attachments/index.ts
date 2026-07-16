/**
 * lib/attachments — the per-row attachments subsystem barrel.
 *
 * Re-exports the shared upload guards + size limits, the traversal-proof storage
 * writer/resolver, and the typed action-result contract, so consumers import from
 * `@/lib/attachments` instead of reaching into individual modules (mirrors
 * lib/csv/index.ts).
 *
 * NOTE: the Server Actions themselves (`uploadAttachment` / `deleteAttachment` /
 * `confirmAttachmentColumn` / `matchAttachments`) are NOT re-exported here — a
 * runtime re-export through a barrel that non-server code imports would drag the
 * "use server" module into a client bundle. The UI imports the actions directly
 * from `@/lib/attachments/actions`; this barrel exposes only pure helpers + types.
 */

export {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_BYTES,
  uploadAttachmentSchema,
} from "./schema";
export type { UploadAttachment } from "./schema";

export {
  writeAttachment,
  resolveAttachmentPath,
  attachmentExists,
} from "./storage";

export { computeAttachmentMatch } from "./match";
export type { AttachmentMatch, MatchableAttachment } from "./match";

export type {
  ActionError,
  AttachmentListResult,
  ConfirmColumnResult,
  MatchResult,
} from "./actions-core";
