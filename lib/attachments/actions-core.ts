/**
 * lib/attachments/actions-core — the testable orchestration seams behind the
 * attachment Server Actions in ./actions.ts. This module deliberately carries NO
 * server-action directive: in Next.js every runtime export of a server-action
 * module is registered as a client-invocable endpoint, and these seams accept a
 * caller-supplied `userId` for test injection. Exporting them from the action
 * module would let a client bypass `auth()` and pass any id they like (T-07-04 /
 * AUTH-02). Here they are plain server-side functions: importable by ./actions.ts
 * and by tests, but never wire-callable.
 *
 * The server-action wrappers in ./actions.ts are the ONLY public surface; each
 * re-derives `userId` via Clerk's `auth()` before delegating down to this file.
 *
 * Seams:
 *   uploadAttachmentCore  — FormData file → guard (instanceof File +
 *     uploadAttachmentSchema) → duplicate-name check → GUARDS PASS, THEN write the
 *     bytes AND insert the DAL row together (no orphaned file, Pitfall 5). One file
 *     per call (the 10 MB attachment cannot pass a 4 MB body limit, so uploads are
 *     one-at-a-time).
 *   listAttachmentsCore   — the caller's pending uploads.
 *   deleteAttachmentCore  — remove the DAL row (best-effort unlink the bytes) and
 *     return the refreshed list; a cross-tenant id is a benign not-found.
 *   confirmAttachmentColumnCore — persist the user's chosen attachment column on
 *     their recipient set (0-row cross-tenant → not_found).
 *
 * SECURITY (T-07-CRED): an ActionError never carries file bytes or a raw Error —
 * `raw` is ALWAYS a string.
 */

import { z } from "zod";

import { parseCsv, resolveAttachmentColumn } from "@/lib/core";
import {
  createAttachment,
  listPendingAttachmentsForUser,
  deleteAttachmentForUser,
  setAttachmentColumnForUser,
  getRecipientSetForUser,
  type PersistableAttachment,
} from "@/lib/data";
import { readUpload } from "@/lib/csv";
import { writeAttachment, attachmentExists, resolveAttachmentPath } from "./storage";
import {
  uploadAttachmentSchema,
  MAX_PENDING_ATTACHMENTS,
  MAX_PENDING_ATTACHMENT_BYTES,
} from "./schema";
import { computeAttachmentMatch, type AttachmentMatch } from "./match";

/** A pending upload row as returned to the UI (the DAL select model). */
type PendingAttachment = Awaited<
  ReturnType<typeof listPendingAttachmentsForUser>
>[number];

/**
 * The typed failure surface the seams return. A closed union of message-only
 * shapes — `raw` is ALWAYS a string, never a raw Error or file bytes (T-07-CRED /
 * D-06). This is the contract the compose upload UI (Plan 04) matches over.
 */
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "wrong_type" }
  | { kind: "too_large" }
  | { kind: "duplicate_filename" }
  | { kind: "quota_exceeded" }
  | { kind: "not_found" }
  | { kind: "unknown"; raw: string };

/** The uniform result the list-returning seams resolve to (never reject). */
export type AttachmentListResult =
  | { ok: true; data: PendingAttachment[] }
  | { ok: false; error: ActionError };

/** The uniform result the confirm-column seam resolves to (never rejects). */
export type ConfirmColumnResult =
  | { ok: true }
  | { ok: false; error: ActionError };

/** The uniform result the compose-time match seam resolves to (never rejects). */
export type MatchResult =
  | { ok: true; data: AttachmentMatch }
  | { ok: false; error: ActionError };

// The client passes the recipientSetId only; coerce + validate it as a positive
// integer so a missing/non-numeric value fails cleanly rather than resolving a
// bogus row (mirrors lib/compose/actions-core.ts).
const recipientSetIdSchema = z.coerce.number().int().positive();

// papaparse emits `UndetectableDelimiter` for a legitimate single-column CSV (and
// for an empty file) — the parse itself SUCCEEDS. Filter it out of the misparse
// gate; genuine structural errors still surface. Mirrors lib/csv/actions-core.ts.
function hasStructuralParseError(
  errors: ReturnType<typeof parseCsv>["parseErrors"],
): boolean {
  return errors.some((e) => e.code !== "UndetectableDelimiter");
}

/**
 * Guard the uploaded FormData `file` field with the SHARED zod schema (so the
 * client resolver and the server can never diverge), then map its failure onto the
 * typed union: a size failure is `too_large`, a non-`File` value is `wrong_type`.
 * Mirrors lib/csv/actions-core.ts guardFile.
 */
function guardFile(
  formData: FormData,
):
  | { ok: true; file: File; name: string }
  | { ok: false; error: ActionError } {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: { kind: "wrong_type" } };
  }
  const parsed = uploadAttachmentSchema.safeParse({
    name: file.name,
    size: file.size,
  });
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((i) => i.path[0] === "size");
    return { ok: false, error: { kind: tooLarge ? "too_large" : "wrong_type" } };
  }
  // Carry the SANITIZED name (control chars stripped by the schema, WR-06) — the
  // caller persists + matches on this, never the raw File.name.
  return { ok: true, file, name: parsed.data.name };
}

/** Normalize a filename for duplicate comparison: trimmed + lower-cased. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Upload seam (testable): guard → duplicate check → GUARDS PASS, THEN write bytes
 * + insert row together. The write happens ONLY after every guard passes, so a
 * rejected upload never leaves an orphan file on disk (Pitfall 5). Returns the
 * refreshed pending list.
 */
export async function uploadAttachmentCore(
  userId: string,
  formData: FormData,
): Promise<AttachmentListResult> {
  try {
    const guard = guardFile(formData);
    if (!guard.ok) return { ok: false, error: guard.error };

    const bytes = Buffer.from(await guard.file.arrayBuffer());

    // Reject a duplicate ORIGINAL filename among the user's pending uploads
    // (case-insensitive, trimmed) BEFORE writing anything — no orphaned file.
    const pending = await listPendingAttachmentsForUser(userId);
    const target = normName(guard.name);
    if (pending.some((a) => normName(a.filename) === target)) {
      return { ok: false, error: { kind: "duplicate_filename" } };
    }

    // Per-user quota gate BEFORE any disk write (WR-02): cap the count and total
    // bytes of the caller's pending/draft uploads so one tenant cannot loop uploads
    // and exhaust the shared volume. `pending` already counts unstamped + still-draft
    // rows (WR-01), which is exactly the on-disk-but-unconsumed set.
    const pendingBytes = pending.reduce((sum, a) => sum + a.size_bytes, 0);
    if (
      pending.length >= MAX_PENDING_ATTACHMENTS ||
      pendingBytes + guard.file.size > MAX_PENDING_ATTACHMENT_BYTES
    ) {
      return { ok: false, error: { kind: "quota_exceeded" } };
    }

    // All guards passed — NOW write the bytes and insert the row together.
    const { storagePath } = writeAttachment(bytes);
    const values: PersistableAttachment = {
      filename: guard.name,
      storage_path: storagePath,
      size_bytes: guard.file.size,
    };
    await createAttachment(userId, values);

    return { ok: true, data: await listPendingAttachmentsForUser(userId) };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

/** List seam (testable): the caller's pending uploads. */
export async function listAttachmentsCore(
  userId: string,
): Promise<AttachmentListResult> {
  try {
    return { ok: true, data: await listPendingAttachmentsForUser(userId) };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

/**
 * Delete seam (testable): remove the owner-scoped DAL row, best-effort unlink the
 * bytes, and return the refreshed list. A cross-tenant/absent id removes zero rows
 * (the DAL AND(id, userId) filter) — a benign not-found, never a throw or a leak.
 */
export async function deleteAttachmentCore(
  userId: string,
  id: number,
): Promise<AttachmentListResult> {
  try {
    const removed = await deleteAttachmentForUser(userId, id);
    // Best-effort byte cleanup for a genuinely removed row. A missing file is not
    // an error (the row is already gone); never surface a filesystem probe.
    for (const row of removed) {
      try {
        if (attachmentExists(row.storage_path)) {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(resolveAttachmentPath(row.storage_path));
        }
      } catch {
        // ignore — the DAL row is the source of truth; a stray file is harmless.
      }
    }
    return { ok: true, data: await listPendingAttachmentsForUser(userId) };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

/**
 * Confirm-column seam (testable): persist the user's chosen attachment column on
 * their recipient set. `setAttachmentColumnForUser` filters on AND(id, userId), so
 * a cross-tenant (or absent) id updates ZERO rows → not_found (never a throw or a
 * leak). Persisting here means the send path uses the chosen column, never a
 * re-detect (ATCH-01).
 */
export async function confirmAttachmentColumnCore(
  userId: string,
  setId: number,
  column: string,
): Promise<ConfirmColumnResult> {
  try {
    const updated = await setAttachmentColumnForUser(userId, setId, column);
    if (updated.length === 0) {
      return { ok: false, error: { kind: "not_found" } };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

/**
 * Compose-time match seam (testable): resolve the recipient set userId-scoped,
 * re-read + parse its stored CSV, resolve the attachment column
 * (`set.attachment_column ?? detectAttachmentColumn`), and match it against the
 * user's PENDING uploads via the SHARED `computeAttachmentMatch`. It matches
 * against PENDING uploads because no campaign exists yet on /compose (Plan 03's
 * confirm gate calls the SAME matcher against the campaign's stamped rows).
 *
 * The storage path is resolved SERVER-side from a userId-scoped row, never from
 * the client (T-07-04 / traversal). A cross-tenant/bogus id → not_found.
 */
export async function matchAttachmentsCore(
  userId: string,
  recipientSetId: number,
): Promise<MatchResult> {
  const idParsed = recipientSetIdSchema.safeParse(recipientSetId);
  if (!idParsed.success) {
    return { ok: false, error: { kind: "not_found" } };
  }

  // Resolve the set from a userId-scoped lookup — a set owned by another tenant
  // (or a bogus id) returns undefined → not_found. NEVER trust a client path.
  const set = await getRecipientSetForUser(userId, idParsed.data);
  if (!set) return { ok: false, error: { kind: "not_found" } };

  try {
    // storage_path came from the userId-scoped row above; readUpload also enforces
    // the traversal boundary. papaparse runs server-side (never ships to browser).
    const bytes = readUpload(set.storage_path);
    const { columns, rows, parseErrors } = parseCsv(bytes);
    if (hasStructuralParseError(parseErrors)) {
      return { ok: false, error: { kind: "unknown", raw: "The recipient list could not be parsed." } };
    }

    // Resolve the attachment column via the SINGLE shared helper the confirm gate +
    // worker also use (WR-03): a confirmed column wins, else auto-detect that never
    // co-opts the email column — so the compose card can't false-positive on emails
    // and show a spurious "missing attachments" block the confirm gate disagrees with.
    const attachmentColumn = resolveAttachmentColumn(set, columns, rows);
    const pending = await listPendingAttachmentsForUser(userId);
    return {
      ok: true,
      data: computeAttachmentMatch(columns, rows, attachmentColumn, pending),
    };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}
