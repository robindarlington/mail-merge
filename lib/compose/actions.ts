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

import { z } from "zod";

import {
  previewCampaignCore,
  saveTemplateCore,
  deleteTemplateCore,
  type PreviewResult,
  type SaveResult,
  type DeleteTemplateResult,
} from "./actions-core";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the compose UI (04-04/05) imports its contract from here.
export type {
  PreviewReport,
  PreviewResult,
  SaveResult,
  ActionError,
  DeleteTemplateResult,
  DeleteTemplateError,
} from "./actions-core";

// The client sends only a template id; coerce + validate it as a positive integer
// so a missing/non-numeric/0/negative id fails as `validation` before any DB touch.
const templateIdSchema = z.coerce.number().int().positive();

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

/**
 * deleteTemplate (tpl): auth → validate id → delete. Re-derives `userId`
 * server-side; the client-supplied `id` is only a proposal — the core owner-scopes
 * it (T-tpl-IDOR-2). Coerces the id with `templateIdSchema` (a missing/non-numeric/
 * 0/negative id fails as `validation` before any DB touch), then delegates to
 * `deleteTemplateCore`. On success revalidates the list detail page so the removed
 * template drops off its library. A campaign-referenced template returns `in_use`.
 */
export async function deleteTemplate(
  id: unknown,
): Promise<DeleteTemplateResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsed = templateIdSchema.safeParse(id);
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  const result = await deleteTemplateCore(userId, parsed.data);
  if (result.ok) {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/lists/[id]", "page");
  }
  return result;
}
