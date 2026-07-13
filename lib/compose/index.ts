/**
 * lib/compose — the compose (editor + preview + template-save) subsystem barrel.
 *
 * Re-exports the shared compose-form guard (client resolver + server) and the
 * typed action-result contract, so consumers import from `@/lib/compose` instead
 * of reaching into individual modules (mirrors lib/csv/index.ts).
 *
 * NOTE: the two Server Actions themselves (`previewCampaign` / `saveTemplate`)
 * are NOT re-exported here — a runtime re-export through a barrel that non-server
 * code imports would drag the "use server" module into a client bundle. The UI
 * imports the actions directly from `@/lib/compose/actions`; this barrel exposes
 * only the shared schema and the (erased) types.
 */

export { composeFormSchema } from "./schema";
export type { ComposeFormValues } from "./schema";

export type {
  PreviewReport,
  PreviewResult,
  SaveResult,
  ActionError,
} from "./actions-core";
