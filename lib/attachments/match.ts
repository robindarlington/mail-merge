/**
 * lib/attachments/match — the SINGLE shared server-side attachment matcher
 * (ATCH-01 / ATCH-02).
 *
 * `computeAttachmentMatch` is a PURE function that both compose-time surfaces run:
 *   - the compose card (this plan, Plan 02) matches a recipient set against the
 *     user's PENDING uploads (no campaign yet);
 *   - the confirm gate (Plan 03) matches the same set against the campaign's
 *     STAMPED attachments.
 * Sharing one matcher means both surfaces produce identical numbers with ZERO
 * divergence — a missing-file block on the confirm gate can never disagree with
 * the compose card's summary (the checker's missing-seam fix).
 *
 * Matching model (CONTEXT decision): a CSV cell names an original filename; a row
 * is matched against the user's uploaded files by `filename.trim().toLowerCase()`.
 * An EMPTY cell contributes nothing (send-without-attachment, NOT a miss). A
 * non-empty cell whose file was never uploaded — or was uploaded but is missing on
 * disk — is a MISS (the pre-send blocking error, ATCH-02).
 */

import { attachmentExists } from "./storage";
import { MAX_MESSAGE_BYTES } from "./schema";
import type { Row } from "@/lib/core";

/** The minimal attachment shape the matcher needs (a DAL row satisfies it). */
export type MatchableAttachment = {
  filename: string;
  storage_path: string;
  size_bytes: number;
};

/** The server-computed match summary both compose surfaces render. */
export type AttachmentMatch = {
  /** The resolved attachment column, or null when none was chosen/detected. */
  attachmentColumn: string | null;
  /** Rows whose non-empty cell matched an uploaded file (present in the DB set). */
  rowsWithAttachment: number;
  /** Matched rows whose file is actually present on disk (ready to send). */
  attachmentTotal: number;
  /** Deduped sample of missing referenced filenames (cap 5) for the UI. */
  missingAttachmentFilenames: string[];
  /** Total rows referencing a file that is missing (never-uploaded or off-disk). */
  missingAttachmentCount: number;
  /** Rows whose attachment exceeds the per-message cap (MAX_MESSAGE_BYTES). */
  oversizeRowCount: number;
  /** The first row's matched filename, for a preview chip (null when none). */
  sampleAttachment: string | null;
};

const MISSING_SAMPLE_CAP = 5;

/** Normalize a filename for matching: trimmed + lower-cased. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Compute the attachment match summary for a recipient set against a candidate
 * attachment list. Pure — no DB, resolves presence via `attachmentExists` only.
 *
 * When `attachmentColumn` is null the CSV designates no attachments, so every
 * field is the zero/empty case.
 */
export function computeAttachmentMatch(
  columns: string[],
  rows: Row[],
  attachmentColumn: string | null,
  attachments: MatchableAttachment[],
): AttachmentMatch {
  const empty: AttachmentMatch = {
    attachmentColumn,
    rowsWithAttachment: 0,
    attachmentTotal: 0,
    missingAttachmentFilenames: [],
    missingAttachmentCount: 0,
    oversizeRowCount: 0,
    sampleAttachment: null,
  };

  // No column (or a column that isn't in the CSV) → nothing to match.
  if (!attachmentColumn || !columns.includes(attachmentColumn)) {
    return empty;
  }

  // Filename → attachment map, keyed by the normalized original filename.
  const byName = new Map<string, MatchableAttachment>();
  for (const att of attachments) {
    byName.set(normName(att.filename), att);
  }

  let rowsWithAttachment = 0;
  let attachmentTotal = 0;
  let missingAttachmentCount = 0;
  let oversizeRowCount = 0;
  let sampleAttachment: string | null = null;
  // Deduped missing sample (insertion order, capped for the UI).
  const missingSeen = new Set<string>();
  const missingSample: string[] = [];

  const addMissing = (name: string) => {
    missingAttachmentCount++;
    const key = normName(name);
    if (!missingSeen.has(key)) {
      missingSeen.add(key);
      if (missingSample.length < MISSING_SAMPLE_CAP) missingSample.push(name);
    }
  };

  rows.forEach((row, idx) => {
    const cell = (row[attachmentColumn] ?? "").trim();
    if (!cell) return; // empty cell — send without attachment, not a miss

    const att = byName.get(normName(cell));
    if (att) {
      // A referenced file that exists in the user's uploads.
      rowsWithAttachment++;
      if (att.size_bytes > MAX_MESSAGE_BYTES) oversizeRowCount++;
      if (attachmentExists(att.storage_path)) {
        attachmentTotal++;
        if (idx === 0) sampleAttachment = att.filename;
      } else {
        // DB-present but missing on disk — still a blocking miss (ATCH-02).
        addMissing(att.filename);
      }
    } else {
      // Referenced a file that was never uploaded.
      addMissing(cell);
    }
  });

  return {
    attachmentColumn,
    rowsWithAttachment,
    attachmentTotal,
    missingAttachmentFilenames: missingSample,
    missingAttachmentCount,
    oversizeRowCount,
    sampleAttachment,
  };
}
