/**
 * `toResultsCsv` (HIST-03) — pure serializer for a campaign's per-recipient
 * send records into a downloadable results CSV.
 *
 * This module is PURE: it imports nothing from `@/lib/db` or `@/lib/data`. It
 * takes plain send-record-shaped objects and returns a CSV string. The export
 * route (app/(app)/campaigns/[id]/export/route.ts) does the userId-scoped read
 * and passes the rows here — keeping the escaping/neutralization discipline in
 * one testable place.
 *
 * Two safety layers, applied per field in this ORDER (order matters):
 *
 *  1. Formula-injection guard (T-06-18): a CSV cell whose first character is one
 *     of `= + - @`, a tab (\t), or a CR (\r) can be interpreted by Excel/Google
 *     Sheets as a formula — a real client-side code-execution vector. We prepend
 *     a single quote `'` so the spreadsheet treats the cell as literal text.
 *
 *  2. RFC-4180 quoting: a field containing a comma, double-quote, CR, or LF is
 *     wrapped in double quotes with any embedded double-quote doubled. Applied
 *     AFTER the guard so the injected `'` is inside the quoted value.
 *
 * Rows are joined with CRLF (`\r\n`) per RFC-4180's line terminator. An empty
 * input yields just the header line.
 */

/** send_records fields exported to the results CSV. */
export type ResultsCsvRow = {
  to_addr: string;
  status: string;
  error: string | null;
  message_id: string | null;
  sent_at: number | null;
};

/** Column headers, in output order. */
const HEADER = ["Recipient", "Status", "Reason", "Message ID", "Sent at"];

/** Characters that make a spreadsheet treat a leading cell as a formula. */
const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Escape a single field: neutralize formula-injection FIRST, then apply RFC-4180
 * quoting. Returns the field exactly as it should appear between delimiters.
 */
function csvField(value: string): string {
  // 1. Formula-injection guard — prefix a literal single quote so a spreadsheet
  //    treats the cell as text, never a formula.
  let field = value;
  if (field.length > 0 && FORMULA_LEADERS.has(field[0])) {
    field = `'${field}`;
  }

  // 2. RFC-4180 quoting — wrap and double embedded quotes when the value carries
  //    a comma, double-quote, CR, or LF.
  if (/[",\r\n]/.test(field)) {
    field = `"${field.replace(/"/g, '""')}"`;
  }

  return field;
}

/**
 * Derive the human status label for a row. The worker records crash-recovered
 * rows by prefixing their `error` with "interrupted:"; surface that as a
 * distinct "interrupted" label so the CSV mirrors the UI's distinction rather
 * than lumping it in with plain "failed".
 */
function statusLabel(row: ResultsCsvRow): string {
  if (row.error?.startsWith("interrupted:")) return "interrupted";
  return row.status;
}

/** Render a unixepoch-seconds timestamp as an ISO string, empty when null. */
function renderSentAt(sent_at: number | null): string {
  if (sent_at == null) return "";
  return new Date(sent_at * 1000).toISOString();
}

/**
 * Serialize send records into a results CSV string. Header row first, one row
 * per record, CRLF-terminated, every field RFC-4180-quoted and
 * formula-injection-safe. An empty input returns just the header line.
 */
export function toResultsCsv(rows: ResultsCsvRow[]): string {
  const lines: string[] = [HEADER.map(csvField).join(",")];

  for (const row of rows) {
    const fields = [
      row.to_addr,
      statusLabel(row),
      row.error ?? "",
      row.message_id ?? "",
      renderSentAt(row.sent_at),
    ];
    lines.push(fields.map(csvField).join(","));
  }

  return lines.join("\r\n");
}
