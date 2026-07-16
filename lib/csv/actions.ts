"use server";

/**
 * lib/csv/actions — the two Server Actions behind the CSV uploader (CSV-01..05 /
 * AUTH-02). This is the seam that ties Clerk identity to the parse/persist core
 * (03-03) and the userId-scoped recipient_sets DAL (03-02), and it defines the
 * typed result contract the uploader UI (03-04) consumes:
 *
 *   parseUploadedCsv  — FormData → parse → auto-detect email column → a summary
 *                       with per-column invalid counts. Persists NOTHING.
 *   saveRecipientSet  — re-validate the confirmed column + re-sent file → write
 *                       bytes → insert the userId-scoped recipient_sets row.
 *
 * SECURITY:
 *  - T-3-IDOR / AUTH-02: every runtime export of a server-action module is a
 *    client-invocable endpoint, so this file exports ONLY the two actions above —
 *    each re-derives `userId` server-side via `auth()` and passes it to the core;
 *    a client-supplied id is never trusted. The userId-accepting seams live in
 *    ./actions-core.ts (no server-action directive), where they are imports, not
 *    endpoints.
 *  - T-3-CRED / D-06: no action return ever carries file bytes or a raw Error —
 *    a `raw` is always a message STRING and `invalidCounts` is a column→number map.
 */

import {
  parseUploadedCsvCore,
  saveRecipientSetCore,
  renameRecipientSetCore,
  deleteRecipientSetCore,
  type ParseResult,
  type SaveResult,
  type RenameResult,
  type DeleteResult,
} from "./actions-core";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the uploader (03-04) imports its contract from here.
export type {
  ParseSummary,
  ParseResult,
  SaveResult,
  RenameResult,
  DeleteResult,
  ActionError,
} from "./actions-core";

/**
 * parseUploadedCsv (CSV-01/02/03/04): auth → parse → summarize. Rejects
 * unauthenticated callers before any work. Delegates the guard/parse/detect flow
 * to `parseUploadedCsvCore`. Persists nothing.
 */
export async function parseUploadedCsv(
  formData: FormData,
): Promise<ParseResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return parseUploadedCsvCore(userId, formData);
}

/**
 * saveRecipientSet (CSV-05): auth → re-validate → persist. Rejects
 * unauthenticated callers before any write. Delegates re-validate → writeUpload →
 * createRecipientSet to `saveRecipientSetCore`, which writes bytes only after
 * every guard passes (orphan avoidance).
 */
export async function saveRecipientSet(
  formData: FormData,
): Promise<SaveResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return saveRecipientSetCore(userId, formData);
}

/**
 * renameList (r8d): auth → validate → owner-scoped rename. Rejects unauthenticated
 * callers before any work, then delegates to `renameRecipientSetCore`, which
 * validates the label/id and UPDATEs by AND(id, userId) — a client-supplied `id`
 * is only a proposal; the re-derived `userId` owns the row (T-r8d-01 / IDOR). On
 * success revalidates the Lists surface so the new name shows on the next render.
 */
export async function renameList(
  id: unknown,
  label: unknown,
): Promise<RenameResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const result = await renameRecipientSetCore(userId, id, label);
  if (result.ok) {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/lists");
  }
  return result;
}

/**
 * deleteList (mdt): auth → owner-scoped delete. Rejects unauthenticated callers
 * before any work, then delegates to `deleteRecipientSetCore`, which guards the
 * in-use case (a campaign references the list → blocked), owner-scopes the DELETE
 * by AND(id, userId) (a client `id` is only a proposal — T-mdt-01 / IDOR), and
 * unlinks the stored CSV. On success revalidates the Lists surface so the removed
 * list drops off the next render. A referenced list returns `in_use`.
 */
export async function deleteList(id: unknown): Promise<DeleteResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const result = await deleteRecipientSetCore(userId, id);
  if (result.ok) {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/lists");
  }
  return result;
}
