/**
 * Worker maintenance routines (SC-4 / RESEARCH Finding 4) — loop-free + injectable.
 *
 * Two low-frequency, idle-aware operational routines that keep a long-lived
 * deployment healthy. They live here (NOT inline in the poll loop) so the seam is
 * unit-tested against a temp DB without spinning any timer; worker/index.ts calls
 * them from its idle branch on env-tunable cadences.
 *
 *  1. checkpointWal — SQLite's PASSIVE auto-checkpoint cannot reset the WAL while a
 *     reader holds a snapshot; with two long-lived processes (web + worker) each
 *     holding read snapshots, the WAL grows unbounded between restarts. An explicit
 *     `wal_checkpoint(TRUNCATE)` (subject to busy_timeout) checkpoints and truncates
 *     the WAL to 0 bytes — but it can still return `busy:1` WITHOUT truncating if a
 *     reader held a snapshot the whole time (PITFALLS #7). We inspect and log the
 *     returned row; we NEVER assume the WAL shrank, and never throw on busy.
 *
 *  2. sweepOrphanAttachments — pre-campaign uploads that are never stamped
 *     (`campaign_id IS NULL`) or abandoned in a `draft` campaign accumulate files
 *     forever. This sweep deletes ONLY those, and only once older than `orphanDays`
 *     (default 7). It deletes the DB row FIRST (the DB is the source of truth for
 *     the pending-bytes quota) inside a transaction, THEN unlinks the file; a failed
 *     unlink is counted and leaves a harmless disk-only file (the phase-7 worker
 *     already tolerates missing attachment files). It logs COUNTS ONLY — never a
 *     filename, storage path, or userId (T-08-08).
 *
 * Discipline: no cron, no new dependency, no wall-clock timers baked in. The
 * connection / db / clock / unlink / logger are all passed in so tests stay
 * deterministic and the routines never open the DB themselves (single opener, D-04).
 */

import type Database from "better-sqlite3";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { attachments, campaigns, type Db } from "@/lib/db";

/** Minimal structural logger — pino's `logger.info(obj, msg)` satisfies this. */
type LogFn = (obj: Record<string, unknown>, msg?: string) => void;
export interface MaintenanceLogger {
  info: LogFn;
  warn?: LogFn;
}

/** The row `PRAGMA wal_checkpoint(TRUNCATE)` returns. */
export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/**
 * Run `wal_checkpoint(TRUNCATE)` on the shared connection, returning and logging
 * the `{busy, log, checkpointed}` row. A `busy:1` result means a reader held a
 * snapshot the whole time so the WAL did NOT truncate — it is returned and logged,
 * never thrown, so the operator can see the WAL did not shrink (PITFALLS #7).
 */
export function checkpointWal(
  connection: Database.Database,
  logger: MaintenanceLogger,
): WalCheckpointResult {
  const rows = connection.pragma(
    "wal_checkpoint(TRUNCATE)",
  ) as WalCheckpointResult[];
  const row = rows?.[0] ?? { busy: 0, log: 0, checkpointed: 0 };

  logger.info(
    { busy: row.busy, log: row.log, checkpointed: row.checkpointed },
    "wal checkpoint",
  );
  return row;
}

/** Options for {@link sweepOrphanAttachments} — everything injected for testability. */
export interface SweepOptions {
  db: Db;
  /** Current time in UNIX SECONDS (matches `attachments.created_at`). */
  now: number;
  /** Age threshold in days; only orphans older than this are swept. */
  orphanDays: number;
  /** Synchronous unlink; may throw (missing file / EPERM) — failures are counted. */
  unlink: (storagePath: string) => void;
  logger: MaintenanceLogger;
}

/** Counts returned by the sweep — the ONLY thing ever logged (no user data). */
export interface SweepResult {
  deletedRows: number;
  deletedFiles: number;
  unlinkFailures: number;
}

/**
 * Delete aged orphan attachments (rows + files). An orphan is an attachment that
 * is unstamped (`campaign_id IS NULL`) OR stamped to a `draft` campaign, AND older
 * than `orphanDays`. Rows belonging to queued/running/completed/failed campaigns
 * are NEVER touched. For each orphan: the DB row is deleted first inside a
 * transaction (the DB is the quota source of truth), then the file is unlinked; a
 * failed unlink increments `unlinkFailures` and leaves a disk-only file. Logs the
 * three counts only — never a filename, path, or userId.
 */
export function sweepOrphanAttachments(opts: SweepOptions): SweepResult {
  const { db, now, orphanDays, unlink, logger } = opts;
  const cutoff = now - orphanDays * 86_400;

  // Campaigns still in `draft` — their attachments are still orphan candidates.
  const draftCampaignIds = db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.status, "draft"));

  // Candidate orphans: (unstamped OR draft-stamped) AND older than the cutoff.
  const candidates = db
    .select({ id: attachments.id, storage_path: attachments.storage_path })
    .from(attachments)
    .where(
      and(
        lt(attachments.created_at, cutoff),
        or(
          isNull(attachments.campaign_id),
          inArray(attachments.campaign_id, draftCampaignIds),
        ),
      ),
    )
    .all();

  let deletedRows = 0;
  let deletedFiles = 0;
  let unlinkFailures = 0;

  for (const c of candidates) {
    // Row-first: commit the DB delete (the quota source of truth) BEFORE touching
    // the file. better-sqlite3 transactions are synchronous, so this commits
    // atomically before the unlink runs.
    //
    // TOCTOU guard (WR-01): the web process is a separate writer — it can flip a
    // campaign draft → queued (user clicks Send) between the candidate SELECT
    // above and this row's DELETE. An unconditional `WHERE id = ?` would then
    // delete the attachment of a now-live campaign (silent data loss: every
    // email sends without its attachment). So the FULL orphan predicate is
    // re-asserted inside the DELETE itself; SQLite evaluates it atomically under
    // the write lock. `changes === 0` means the row stopped being an orphan (or
    // was already deleted) — skip it, and NEVER unlink its file.
    const { changes } = db.transaction((tx) =>
      tx
        .delete(attachments)
        .where(
          and(
            eq(attachments.id, c.id),
            lt(attachments.created_at, cutoff),
            or(
              isNull(attachments.campaign_id),
              inArray(attachments.campaign_id, draftCampaignIds),
            ),
          ),
        )
        .run(),
    );
    if (changes !== 1) continue; // no longer an orphan — keep the file

    deletedRows += 1;

    try {
      unlink(c.storage_path);
      deletedFiles += 1;
    } catch {
      // A disk-only leftover is safe (the send path tolerates missing files);
      // count it, never log the path.
      unlinkFailures += 1;
    }
  }

  logger.info(
    { deletedRows, deletedFiles, unlinkFailures },
    "attachment orphan sweep",
  );
  return { deletedRows, deletedFiles, unlinkFailures };
}

/**
 * The due-scheduler seam, decoupled from the poll loop: has `intervalMs` elapsed
 * since `lastAt`? A `lastAt` of 0 (never run) is due on the first check whose
 * `now >= intervalMs`. Pure + injectable so the worker's cadence is unit-testable
 * without wall-clock timers.
 */
export function isDue(lastAt: number, intervalMs: number, now: number): boolean {
  return now - lastAt >= intervalMs;
}
