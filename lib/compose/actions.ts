"use server";

/**
 * lib/compose/actions — the two Server Actions behind the compose editor
 * (EDIT-04 / PREV-01..03 / AUTH-02). This is the seam that ties Clerk identity to
 * the preview/save core (04-03) and defines the typed result contract the compose
 * UI (04-04/05) consumes:
 *
 *   previewCampaign — FormData{ recipientSetId } → a userId-scoped, template-
 *                     INDEPENDENT preview report (all rows + columns + totalRows +
 *                     server-resolved emailColumn + invalidEmailCount).
 *   saveTemplate    — FormData{ subject, body } → validate → persist a standalone
 *                     userId-scoped template row.
 *
 * SECURITY:
 *  - T-4-IDOR / T-4-ENDPOINT / AUTH-02: every runtime export of a server-action
 *    module is a client-invocable endpoint, so this file exports ONLY the two
 *    actions below — each re-derives `userId` server-side via `auth()` and passes
 *    it to the core; a client-supplied id is never trusted. The userId-accepting
 *    seams live in ./actions-core.ts (no server-action directive), where they are
 *    imports, not endpoints.
 *  - T-4-LOG / D-06: no action return ever carries CSV bytes or a raw Error — a
 *    `raw` is always a message STRING.
 */

import {
  previewCampaignCore,
  saveTemplateCore,
  type PreviewResult,
  type SaveResult,
} from "./actions-core";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the compose UI (04-04/05) imports its contract from here.
export type {
  PreviewReport,
  PreviewResult,
  SaveResult,
  ActionError,
} from "./actions-core";

/**
 * previewCampaign (PREV-01/02/03): auth → resolve → preview. Rejects
 * unauthenticated callers before any work. Delegates the resolve/read/parse flow
 * to `previewCampaignCore` with the server-derived userId.
 */
export async function previewCampaign(
  formData: FormData,
): Promise<PreviewResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return previewCampaignCore(userId, formData);
}

/**
 * saveTemplate (EDIT-04): auth → validate → persist. Rejects unauthenticated
 * callers before any write. Delegates the validate → createTemplate flow to
 * `saveTemplateCore`, which writes only after the guard passes.
 */
export async function saveTemplate(formData: FormData): Promise<SaveResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return saveTemplateCore(userId, formData);
}
