/**
 * receipts — durable JSONL send log + the resume set (T-081-DUP / T-081-03).
 *
 * Every live/test send appends ONE JSON line per recipient describing the
 * outcome. The receipt entry deliberately EXCLUDES any secret field — only the
 * address, status, messageId-or-error, and timestamp are persisted (no password,
 * no auth). Because each line is a self-contained JSON object (JSON Lines, not a
 * single array), appends stay valid and atomic across an interrupt/resume.
 *
 * Crash-window mitigation (RESEARCH Pitfall 3): after each append we `fsync` the
 * file so a `sent` line reaches disk BEFORE the next send starts. This shrinks —
 * but does not eliminate — the crash-resend window, so `--resume` is documented
 * as at-least-once (never re-send a recorded `sent`), not exactly-once.
 *
 * The receipts path is the operator-supplied `--receipts` path or one DERIVED
 * from the CSV name (`data.csv` → `data.receipts.jsonl`); writes go only there.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
} from "node:fs";
import { format, parse } from "node:path";

/** Outcome of one recipient send. NEVER carries a secret/password field. */
export type ReceiptStatus = "sent" | "failed";

/** One JSONL receipt line. Secret-free by construction. */
export interface ReceiptEntry {
  to: string;
  status: ReceiptStatus;
  /** Present on `sent`. */
  messageId?: string;
  /** Present on `failed` — the send error MESSAGE only (never the auth object). */
  error?: string;
  timestamp: string;
}

/**
 * Derive the default receipts path from a CSV path by swapping the extension to
 * `.receipts.jsonl` — `mydata.csv` → `mydata.receipts.jsonl`, preserving the dir.
 */
export function deriveReceiptsPath(csvPath: string): string {
  const p = parse(csvPath);
  return format({ dir: p.dir, name: p.name, ext: ".receipts.jsonl" });
}

/**
 * Append one receipt line and fsync it to disk before returning, so the record
 * of a completed send is durable before the next send begins (Pitfall 3).
 */
export function appendReceipt(path: string, entry: ReceiptEntry): void {
  appendFileSync(path, JSON.stringify(entry) + "\n");
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the set of addresses already recorded `sent` in the receipts file, used
 * to skip them on `--resume`. A missing file yields an empty Set; blank and
 * trailing lines are tolerated (mirrors the stub-smtp readLog idiom), and so is
 * a TORN line — the very artifact of the interrupted append this file exists to
 * recover from. An unparseable line is skipped, not fatal: under the documented
 * at-least-once semantics its row is simply re-sent.
 */
export function readSentSet(path: string): Set<string> {
  if (!existsSync(path)) return new Set<string>();
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .reduce((set, line) => {
      try {
        const entry = JSON.parse(line) as ReceiptEntry;
        if (entry.status === "sent" && typeof entry.to === "string") set.add(entry.to);
      } catch {
        // Torn line from an interrupted append — ignore; at-least-once re-sends it.
      }
      return set;
    }, new Set<string>());
}
