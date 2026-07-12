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
  type ParseResult,
  type SaveResult,
} from "./actions-core";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the uploader (03-04) imports its contract from here.
export type {
  ParseSummary,
  ParseResult,
  SaveResult,
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
