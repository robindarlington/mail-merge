/**
 * csv — robust CSV parsing for the mail-merge engine (CSV-02).
 *
 * Replaces the CLI's naive split-at-first-comma (`send-credentials.ts::
 * loadRecipients`) with papaparse in header mode, which correctly handles
 * quoted fields with embedded commas/newlines, CRLF, and a leading UTF-8 BOM
 * (PITFALLS #12). Also validates recipient emails at parse time and returns an
 * invalid-row count (CONCERNS.md gap, CSV-04 foundation) so callers can warn
 * before any SMTP connection.
 *
 * PURITY: imports only papaparse (+ no Node fs/DB/Clerk/Next). Callers pass the
 * already-read CSV text or bytes; this module never touches the filesystem.
 */

import Papa from "papaparse";

export type Row = Record<string, string>;

export interface ParsedCsv {
  /** Ordered column names from the header row (BOM-stripped). */
  columns: string[];
  /** One object per data row, keyed by column name. */
  rows: Row[];
  /** Count of rows whose `email` column failed a simple RFC-lite check. */
  invalidEmailCount: number;
  /** Structural parse errors from papaparse (field-count mismatch, quote errors, etc.). */
  parseErrors: Papa.ParseError[];
}

// Simple RFC-lite email check: a non-empty local part, an @, a dotted domain.
// Deliberately permissive (real validation is the SMTP server's job) — this
// only catches obviously malformed addresses before we open a connection.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The single email-validity predicate shared by every gate (CSV-04): the confirm
 * summary's `countInvalidEmails`, the parse-time `invalidEmailCount`, and the
 * worker's materialize step (WR-05). Trims first; a blank/whitespace value is
 * invalid. Keeping ONE predicate guarantees the count the user confirms and the
 * rows the worker actually sends can never disagree.
 */
export function isValidEmail(value: string | undefined | null): boolean {
  return EMAIL_RE.test((value ?? "").trim());
}

/** Strip a single leading UTF-8 BOM (U+FEFF) if present. */
function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/**
 * Parse CSV `text` (or a Buffer of UTF-8 bytes) into ordered columns + row
 * objects, counting rows with an invalid `email` value.
 */
export function parseCsv(input: string | Buffer): ParsedCsv {
  const text = stripBom(
    typeof input === "string" ? input : input.toString("utf8"),
  );

  const result = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true,
    // Defensive: papaparse also strips a BOM, but we already did above.
    transformHeader: (h) => h.trim(),
  });

  const columns = result.meta.fields ?? [];
  const rows = result.data;

  let invalidEmailCount = 0;
  if (columns.includes("email")) {
    for (const row of rows) {
      if (!isValidEmail(row.email)) invalidEmailCount++;
    }
  }

  return { columns, rows, invalidEmailCount, parseErrors: result.errors };
}

// Header names that strongly imply an email column, checked after normalization.
const NAME_HINTS = ["email", "e-mail", "mail", "email address", "recipient"];

/**
 * Guess which column holds the recipient email address (CSV-03).
 *
 * Two-stage heuristic — the human confirm/override step downstream is the real
 * gate, this only supplies the default:
 *   1) Header-name match: normalize (`trim().toLowerCase()`) and prefer an exact
 *      hit against {@link NAME_HINTS}, then any column whose normalized name
 *      `.includes("email")` (so `Work Email` matches but `mailing_city` does not).
 *   2) Content sampling fallback: over the first 50 rows, score each column by
 *      its EMAIL_RE hit-rate on non-empty values and return the best scorer only
 *      when it clears 0.7; otherwise `null`.
 *
 * Reuses the module's existing {@link EMAIL_RE} and {@link Row} — additive to
 * `parseCsv`, which keeps its literal-`"email"` `invalidEmailCount` intact.
 */
export function detectEmailColumn(
  columns: string[],
  rows: Row[],
): string | null {
  const norm = (s: string) => s.trim().toLowerCase();

  // 1) header-name heuristic (exact/normalized match preferred over substring)
  const byName =
    columns.find((c) => NAME_HINTS.includes(norm(c))) ??
    columns.find((c) => norm(c).includes("email"));
  if (byName) return byName;

  // 2) content-sampling fallback: highest EMAIL_RE hit-rate over a sample
  const sample = rows.slice(0, 50);
  let best: { col: string; score: number } | null = null;
  for (const col of columns) {
    const vals = sample.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (!vals.length) continue;
    const score = vals.filter((v) => EMAIL_RE.test(v)).length / vals.length;
    if (!best || score > best.score) best = { col, score };
  }
  return best && best.score > 0.7 ? best.col : null;
}

/**
 * Count rows whose value in the CONFIRMED `column` fails EMAIL_RE (CSV-04).
 *
 * Unlike `parseCsv`'s hardcoded literal-`"email"` `invalidEmailCount`, this
 * works over whichever column the user confirmed. A blank/whitespace value
 * counts as invalid.
 */
export function countInvalidEmails(rows: Row[], column: string): number {
  let n = 0;
  for (const r of rows) if (!isValidEmail(r[column])) n++;
  return n;
}
