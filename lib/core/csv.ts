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
}

// Simple RFC-lite email check: a non-empty local part, an @, a dotted domain.
// Deliberately permissive (real validation is the SMTP server's job) — this
// only catches obviously malformed addresses before we open a connection.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      const email = (row.email ?? "").trim();
      if (!EMAIL_RE.test(email)) invalidEmailCount++;
    }
  }

  return { columns, rows, invalidEmailCount };
}
