/**
 * lib/csv/actions-core — the testable orchestration seams behind the Server
 * Actions in ./actions.ts. This module deliberately carries NO server-action
 * directive: in Next.js every runtime export of a server-action module is
 * registered as a client-invocable endpoint, and these seams accept a caller
 * supplied `userId` for test injection. Exporting them from the action module
 * would let a client bypass `auth()` and pass any id they like (T-3-IDOR /
 * AUTH-02). Here they are plain server-side functions: importable by
 * ./actions.ts and by tests, but never wire-callable.
 *
 * The server-action wrappers in ./actions.ts are the ONLY public surface; each
 * re-derives `userId` via Clerk's `auth()` before delegating down to this file.
 *
 * Two seams:
 *   parseUploadedCsvCore  — FormData → parse → auto-detect email column →
 *     summary with a per-column invalid-count map. Persists NOTHING (no bytes
 *     touch disk; orphan avoidance, Pitfall 5). The per-column map lets the UI
 *     (03-04) surface the invalid count for a user-overridden column without
 *     shipping papaparse to the browser or re-parsing.
 *   saveRecipientSetCore  — re-validate the re-sent file + the CONFIRMED email
 *     column → count invalid on that confirmed column → write bytes → insert the
 *     userId-scoped recipient_sets row. Bytes are written ONLY after every guard
 *     passes, in the same call that inserts the row (Pitfall 5).
 */

import { parseCsv, detectEmailColumn, countInvalidEmails } from "@/lib/core";
import { createRecipientSet } from "@/lib/data";
import {
  confirmColumnSchema,
  uploadFileSchema,
  MAX_ROWS,
} from "./schema";
import { writeUpload } from "./storage";

/**
 * The summary the parse step returns. `invalidCounts` has ONE entry per column
 * (`countInvalidEmails(rows, col)`); `invalidCount` is the detected column's
 * entry (or 0 when nothing was detected). The per-column map is the override
 * seam — the UI recomputes an override's count from it with no re-parse.
 */
export type ParseSummary = {
  columns: string[];
  detectedEmailColumn: string | null;
  rowCount: number;
  invalidCount: number;
  invalidCounts: Record<string, number>;
};

/**
 * The typed failure surface both seams return. A closed union of message-only
 * shapes — a `raw` field is ALWAYS a string, never a raw Error or file bytes
 * (T-3-CRED / D-06). This is the contract 03-04 pattern-matches over.
 */
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "wrong_type" }
  | { kind: "too_large" }
  | { kind: "too_many_rows" }
  | { kind: "parse_error" }
  | { kind: "empty" }
  | { kind: "unknown"; raw: string };

/** The uniform result the parse seam resolves to (never rejects). */
export type ParseResult =
  | { ok: true; data: ParseSummary }
  | { ok: false; error: ActionError };

/** The uniform result the save seam resolves to (never rejects). */
export type SaveResult =
  | {
      ok: true;
      data: { rowCount: number; filename: string; invalidCount: number };
    }
  | { ok: false; error: ActionError };

/**
 * Guard the uploaded FormData `file` field with the SHARED zod schema (so the
 * client resolver and the server can never diverge), then map its failure onto
 * the typed union: a size failure is `too_large`, any other metadata failure
 * (bad extension / mime) or a non-`File` value is `wrong_type`.
 */
function guardFile(
  formData: FormData,
): { ok: true; file: File } | { ok: false; error: ActionError } {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: { kind: "wrong_type" } };
  }
  const parsed = uploadFileSchema.safeParse({
    name: file.name,
    type: file.type,
    size: file.size,
  });
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((i) => i.path[0] === "size");
    return { ok: false, error: { kind: tooLarge ? "too_large" : "wrong_type" } };
  }
  return { ok: true, file };
}

// papaparse emits `UndetectableDelimiter` for a legitimate single-column CSV
// (and for an empty file) — the parse itself SUCCEEDS. Treating it as a
// structural misparse would wrongly reject valid single-column uploads and make
// the empty-file branch unreachable, so it is filtered out of the misparse gate;
// genuine structural errors (MissingQuotes, TooFewFields, …) still surface as
// parse_error (T-3-MISPARSE).
function hasStructuralParseError(
  errors: ReturnType<typeof parseCsv>["parseErrors"],
): boolean {
  return errors.some((e) => e.code !== "UndetectableDelimiter");
}

/**
 * Parse seam (testable): guard → parse → summarize. NEVER writes to disk.
 *
 * `userId` is accepted for signature parity with the save seam and the "use
 * server" wrapper (the parse step is not yet userId-scoped, but keeping the
 * shape uniform lets both actions delegate identically).
 */
export async function parseUploadedCsvCore(
  userId: string,
  formData: FormData,
): Promise<ParseResult> {
  void userId;

  const guard = guardFile(formData);
  if (!guard.ok) return { ok: false, error: guard.error };

  const bytes = Buffer.from(await guard.file.arrayBuffer());
  const { columns, rows, parseErrors } = parseCsv(bytes);

  if (hasStructuralParseError(parseErrors)) {
    return { ok: false, error: { kind: "parse_error" } };
  }
  if (columns.length === 0) return { ok: false, error: { kind: "empty" } };
  // Enforce the row cap at PARSE time so an oversized file is rejected on the
  // first upload, not only at save (T-3-DOS).
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: { kind: "too_many_rows" } };
  }

  const detectedEmailColumn = detectEmailColumn(columns, rows);
  const invalidCounts: Record<string, number> = Object.fromEntries(
    columns.map((col) => [col, countInvalidEmails(rows, col)]),
  );
  const invalidCount = detectedEmailColumn
    ? invalidCounts[detectedEmailColumn]
    : 0;

  return {
    ok: true,
    data: {
      columns,
      detectedEmailColumn,
      rowCount: rows.length,
      invalidCount,
      invalidCounts,
    },
  };
}

/**
 * Save seam (testable): re-validate the confirmed column + the re-sent file →
 * re-count invalid on the CONFIRMED column → write bytes → insert the row. The
 * write happens ONLY after every guard passes, in the same call that inserts the
 * row, so a rejected upload never leaves an orphan file on disk (Pitfall 5).
 */
export async function saveRecipientSetCore(
  userId: string,
  formData: FormData,
): Promise<SaveResult> {
  const confirmed = confirmColumnSchema.safeParse({
    emailColumn: formData.get("emailColumn"),
  });
  if (!confirmed.success) {
    return {
      ok: false,
      error: { kind: "validation", issues: confirmed.error.issues },
    };
  }
  const emailColumn = confirmed.data.emailColumn;

  const guard = guardFile(formData);
  if (!guard.ok) return { ok: false, error: guard.error };

  const bytes = Buffer.from(await guard.file.arrayBuffer());
  const { columns, rows, parseErrors } = parseCsv(bytes);

  if (hasStructuralParseError(parseErrors)) {
    return { ok: false, error: { kind: "parse_error" } };
  }
  if (columns.length === 0) return { ok: false, error: { kind: "empty" } };
  if (rows.length > MAX_ROWS) {
    return { ok: false, error: { kind: "too_many_rows" } };
  }
  // The confirmed column must be one of the actual headers — a client cannot
  // pin the count/insert to a column the file does not contain (T-3-MISPARSE).
  if (!columns.includes(emailColumn)) {
    return {
      ok: false,
      error: {
        kind: "validation",
        issues: [
          {
            code: "custom",
            path: ["emailColumn"],
            message: "That column isn't in the uploaded file.",
          },
        ],
      },
    };
  }

  // Count invalid on the CONFIRMED column so the persisted set's count is
  // authoritative for the user's chosen column, not the auto-detected one.
  const invalidCount = countInvalidEmails(rows, emailColumn);

  // All guards passed — NOW write the bytes and insert the row together.
  const { storagePath } = writeUpload(bytes);
  await createRecipientSet(userId, {
    filename: guard.file.name,
    columns_json: JSON.stringify(columns),
    row_count: rows.length,
    storage_path: storagePath,
  });

  return {
    ok: true,
    data: { rowCount: rows.length, filename: guard.file.name, invalidCount },
  };
}
