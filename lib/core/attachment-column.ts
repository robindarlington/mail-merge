/**
 * attachment-column — guess which CSV column holds the per-row attachment
 * filename (ATCH-01).
 *
 * Mirrors `detectEmailColumn` (lib/core/csv.ts): a two-stage heuristic that only
 * supplies the DEFAULT for the human confirm/override step downstream — never the
 * final decision.
 *   1) Header-name match: normalize (`trim().toLowerCase()`) and prefer an exact
 *      hit against {@link NAME_HINTS}, then any column whose normalized name
 *      contains "attach" or "file" (so `Attachment File` / `myfile` match).
 *   2) Content-sampling fallback: over the first 50 rows, score each column by the
 *      fraction of non-empty cells that LOOK like a filename (a dot followed by a
 *      1-5 char alnum extension) and return the best scorer only when it clears
 *      0.7; otherwise `null`.
 *
 * PURITY: no fs/DB/Clerk/Next imports — takes the already-parsed columns + rows,
 * matching the rest of lib/core.
 */

import type { Row } from "./csv";

// Header names that strongly imply an attachment-filename column.
const NAME_HINTS = ["attachment", "file", "filename", "attachment_file"];

// A value "looks like a filename" if it ends in a dot + 1-5 alnum extension.
const FILENAME_RE = /\.[a-z0-9]{1,5}$/i;

/**
 * Guess the attachment-filename column (ATCH-01). Returns the column name, or
 * `null` when nothing qualifies — same contract as {@link detectEmailColumn}.
 */
export function detectAttachmentColumn(
  columns: string[],
  rows: Row[],
): string | null {
  const norm = (s: string) => s.trim().toLowerCase();

  // 1) header-name heuristic (exact/normalized match preferred over substring)
  const byName =
    columns.find((c) => NAME_HINTS.includes(norm(c))) ??
    columns.find((c) => norm(c).includes("attach") || norm(c).includes("file"));
  if (byName) return byName;

  // 2) content-sampling fallback: highest filename-shape hit-rate over a sample
  const sample = rows.slice(0, 50);
  let best: { col: string; score: number } | null = null;
  for (const col of columns) {
    const vals = sample.map((r) => (r[col] ?? "").trim()).filter(Boolean);
    if (!vals.length) continue;
    const score = vals.filter((v) => FILENAME_RE.test(v)).length / vals.length;
    if (!best || score > best.score) best = { col, score };
  }
  return best && best.score > 0.7 ? best.col : null;
}
