/**
 * lib/compose/actions-core — the testable orchestration seams behind the compose
 * Server Actions in ./actions.ts. This module deliberately carries NO server-action
 * directive: in Next.js every runtime export of a server-action module is
 * registered as a client-invocable endpoint, and these seams accept a caller
 * supplied `userId` for test injection. Exporting them from the action module
 * would let a client bypass `auth()` and pass any id they like (T-4-IDOR /
 * AUTH-02). Here they are plain server-side functions: importable by
 * ./actions.ts and by tests, but never wire-callable (T-4-ENDPOINT).
 *
 * The server-action wrappers in ./actions.ts are the ONLY public surface; each
 * re-derives `userId` via Clerk's `auth()` before delegating down to this file.
 *
 * Two seams:
 *   previewCampaignCore — recipientSetId → userId-scoped resolve → readUpload →
 *     parseCsv → a TEMPLATE-INDEPENDENT report: all rows + columns + totalRows,
 *     plus the two server-authoritative fields, the resolved email column
 *     (`row.email_column ?? detectEmailColumn`) and the invalid-email count over
 *     ALL rows against that same column. The client passes ONLY a recipientSetId,
 *     never a storage path (T-4-IDOR / T-4-TRAVERSAL). The report deliberately
 *     OMITS the template-DEPENDENT gap aggregates (the unknown-token union + the
 *     empty-value row tally) — those change as the user types and are computed
 *     client-side (Plan 05) from the returned `rows`, so they can never go stale
 *     against the composed template (T-4-DIVERGE).
 *   saveTemplateCore — validate subject/body with the SHARED composeFormSchema →
 *     createTemplate(userId, {subject, body}). The write happens only after the
 *     guard passes; ownership is server-injected by the DAL (T-4-TAMPER-OWNER).
 *
 * SECURITY (T-4-LOG): this module NEVER console.* subject/body/CSV cell values;
 * an ActionError `raw` field is ALWAYS a string, never a raw Error or bytes.
 */

import { z } from "zod";

import { parseCsv, detectEmailColumn, countInvalidEmails } from "@/lib/core";
import {
  getRecipientSetForUser,
  createTemplate,
  getTemplateForUser,
  countCampaignsForTemplate,
  deleteTemplateForUser,
} from "@/lib/data";
import { readUpload } from "@/lib/csv";
import { composeFormSchema } from "./schema";

/**
 * The typed failure surface both seams return. A closed union of message-only
 * shapes — a `raw` field is ALWAYS a string, never a raw Error or CSV bytes
 * (T-4-LOG / D-06). This is the contract the compose UI (Plan 04/05) matches over.
 */
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }
  | { kind: "parse_error" }
  | { kind: "unknown"; raw: string };

/**
 * The preview report the client renders + steps through. TEMPLATE-INDEPENDENT by
 * design: it carries columns / rows / totalRows plus the two server-authoritative
 * fields (`emailColumn`, `invalidEmailCount`). It deliberately OMITS the
 * template-DEPENDENT gap aggregates (the unknown-token union + the empty-value
 * row tally) — freezing those at fetch time would go stale as the user types, so
 * the client computes them reactively from `rows` (Plan 05). `emailColumn` is the SAME value used to
 * compute `invalidEmailCount`, so the rendered "To:" column can never diverge
 * from the counted column (T-4-DIVERGE); it is null only when the server can
 * neither read a persisted column nor detect one.
 */
export type PreviewReport = {
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
  emailColumn: string | null;
  invalidEmailCount: number;
};

/** The uniform result the preview seam resolves to (never rejects). */
export type PreviewResult =
  | { ok: true; data: PreviewReport }
  | { ok: false; error: ActionError };

/** The uniform result the save seam resolves to (never rejects). */
export type SaveResult =
  | { ok: true; data: { id: number } }
  | { ok: false; error: ActionError };

// The client sends the recipientSetId as a FormData string; coerce + validate it
// as a positive integer so a missing/non-numeric value fails as `validation`
// rather than resolving a bogus row (a NaN/0/negative id can never match).
const recipientSetIdSchema = z.coerce.number().int().positive();

// papaparse emits `UndetectableDelimiter` for a legitimate single-column CSV
// (and for an empty file) — the parse itself SUCCEEDS. Treating it as a
// structural misparse would wrongly reject valid single-column uploads, so it is
// filtered out of the misparse gate; genuine structural errors (MissingQuotes,
// TooFewFields, …) still surface as parse_error. Mirrors lib/csv/actions-core.ts.
function hasStructuralParseError(
  errors: ReturnType<typeof parseCsv>["parseErrors"],
): boolean {
  return errors.some((e) => e.code !== "UndetectableDelimiter");
}

/**
 * Preview seam (testable): validate id → userId-scoped resolve → read → parse →
 * summarize. The storage path is resolved SERVER-side from a userId-scoped row,
 * never from the client (T-4-IDOR / T-4-TRAVERSAL). Reads NO subject/body — the
 * report is template-independent, so no merge-token analysis runs here.
 */
export async function previewCampaignCore(
  userId: string,
  formData: FormData,
): Promise<PreviewResult> {
  const idParsed = recipientSetIdSchema.safeParse(formData.get("recipientSetId"));
  if (!idParsed.success) {
    return { ok: false, error: { kind: "validation", issues: idParsed.error.issues } };
  }

  // Resolve the set from a userId-scoped lookup — a set owned by another tenant
  // (or a bogus id) returns undefined → not_found. NEVER trust a client path.
  const row = await getRecipientSetForUser(userId, idParsed.data);
  if (!row) return { ok: false, error: { kind: "not_found" } };

  try {
    // storage_path came from the userId-scoped row above; readUpload also enforces
    // the traversal boundary. papaparse runs server-side (never ships to browser).
    const bytes = readUpload(row.storage_path);
    const { columns, rows, parseErrors } = parseCsv(bytes);

    if (hasStructuralParseError(parseErrors)) {
      return { ok: false, error: { kind: "parse_error" } };
    }

    // Honor the user's confirmed column; fall back to detection only when the
    // persisted column is null. This single value is BOTH the returned "To:"
    // column and the column invalidEmailCount is computed against (T-4-DIVERGE).
    const emailColumn = row.email_column ?? detectEmailColumn(columns, rows);
    const invalidEmailCount = emailColumn
      ? countInvalidEmails(rows, emailColumn)
      : 0;

    return {
      ok: true,
      data: { columns, rows, totalRows: rows.length, emailColumn, invalidEmailCount },
    };
  } catch (e) {
    // raw is ALWAYS a string — never a raw Error or bytes (T-4-LOG / D-06).
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

/**
 * Save seam (testable): validate subject/body with the SHARED schema, then insert
 * a standalone userId-scoped template (EDIT-04). The write happens ONLY after the
 * guard passes; ownership is server-injected by the DAL (T-4-TAMPER-OWNER), so a
 * caller can never spoof it.
 */
export async function saveTemplateCore(
  userId: string,
  formData: FormData,
): Promise<SaveResult> {
  const parsed = composeFormSchema.safeParse({
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  // List-scope stamping (tpl / D1): the compose UI supplies the selected list id so
  // the saved template joins that list's library. The id is OWNER-resolved before
  // stamping — a foreign/bogus id resolves to undefined → not_found, so a caller can
  // never stamp a list they don't own (T-tpl-TAMPER). An ABSENT recipientSetId
  // saves an unscoped (NULL) template, preserving the pre-tpl behavior.
  let recipientSetId: number | undefined;
  const rawSetId = formData.get("recipientSetId");
  if (rawSetId !== null && rawSetId !== "") {
    const idParsed = recipientSetIdSchema.safeParse(rawSetId);
    if (!idParsed.success) {
      return { ok: false, error: { kind: "validation", issues: idParsed.error.issues } };
    }
    const set = await getRecipientSetForUser(userId, idParsed.data);
    if (!set) return { ok: false, error: { kind: "not_found" } };
    recipientSetId = set.id;
  }

  try {
    const [created] = await createTemplate(userId, {
      ...parsed.data,
      recipient_set_id: recipientSetId,
    });
    return { ok: true, data: { id: created.id } };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}

// --- Delete seam (tpl / D2) ---------------------------------------------------
//
// Owner-facing template delete, mirroring deleteCampaignCore's shape. A template
// referenced by ANY campaign is BLOCKED (in_use) — campaigns.template_id is NOT
// NULL with no cascade and PRAGMA foreign_keys=ON, so blocking is the only
// history-preserving option (send_records keep their merged snapshots, D2).

/** The closed error surface the template-delete action returns (message-only). */
export type DeleteTemplateError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }
  | { kind: "in_use" }
  | { kind: "unknown"; raw?: string };

/** The uniform result the template-delete seam + action resolve to (never rejects). */
export type DeleteTemplateResult =
  | { ok: true }
  | { ok: false; error: DeleteTemplateError };

/**
 * Delete seam (testable): userId-scoped pre-check → campaign-reference guard →
 * owner-scoped delete. `getTemplateForUser` first (cross-tenant/bogus id →
 * not_found, deleting nothing). Then countCampaignsForTemplate > 0 → in_use (D2):
 * the template keeps campaign history intact. Otherwise deleteTemplateForUser; a
 * 0-row delete (a concurrent removal under us) maps to not_found. A thrown error
 * (e.g. an FK race where a campaign referenced it between the guard and the DELETE)
 * maps to `{ kind:"unknown", raw }` — raw is ALWAYS a string (D-06 / T-4-LOG).
 */
export async function deleteTemplateCore(
  userId: string,
  id: number,
): Promise<DeleteTemplateResult> {
  const template = await getTemplateForUser(userId, id);
  if (!template) return { ok: false, error: { kind: "not_found" } };

  if ((await countCampaignsForTemplate(userId, id)) > 0) {
    return { ok: false, error: { kind: "in_use" } };
  }

  try {
    const removed = await deleteTemplateForUser(userId, id);
    if (removed.length === 0) return { ok: false, error: { kind: "not_found" } };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }
}
