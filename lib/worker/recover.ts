/**
 * Crash-recovery orphan sweep — the "no double-send ever" seam (SEND-06 / T-06-02).
 *
 * A send_record left in `sending` when the worker died has a GENUINELY UNKNOWN
 * delivery outcome: the SMTP server may have accepted the message a moment before
 * the crash. The only safe move (Pattern 5) is to make that row TERMINAL — `failed`
 * with a distinct interrupted marker — and NEVER auto-resend it. Resetting
 * `sending`→`pending` would re-send a possibly-already-delivered email and violate
 * the hard guarantee "no double-send ever"; that reset is deliberately absent here.
 *
 * The sweep is a SINGLE `UPDATE … WHERE campaign_id=? AND status='sending'` with
 * `RETURNING id`, so the swept-row count comes from the SAME statement that makes
 * the transition — the return value and the `failed_count` bump can never disagree
 * (no count-then-update TOCTOU). The send loop (Plan 02) processes `pending` only,
 * so these now-terminal rows are excluded from any resend.
 *
 * Uses the shared drizzle `db` (better-sqlite3, synchronous via `.all()`/`.run()`);
 * it never opens a Database (single opener, D-04).
 */

import { and, eq, sql } from "drizzle-orm";

import { db, campaigns, send_records } from "@/lib/db";

/** The exact terminal error stamped on an interrupted (orphaned) send. */
const INTERRUPTED_ERROR = "interrupted: delivery status unknown";

/**
 * Sweep every `sending` send_record for `campaignId` to a terminal `failed`
 * (interrupted) state and bump the campaign's `failed_count` by the swept count.
 * Returns the number of rows swept (0 when there were no orphans — a clean no-op).
 * NEVER resets `sending`→`pending`; the interrupted rows are terminal and MUST
 * never be re-sent.
 */
export function recoverOrphanedSending(campaignId: number): number {
  // The sweep and the failed_count bump are ONE synchronous transaction (WR-04):
  // a crash between them (SIGKILL lands here on every deploy) would otherwise
  // desynchronize failed_count from the row states forever, since the counters are
  // never reconciled from rows. better-sqlite3 is synchronous, so the whole
  // sweep+bump commits atomically or not at all.
  return db.transaction((tx) => {
    // Single atomic sweep; the RETURNING rows ARE the count (no separate SELECT).
    const swept = tx
      .update(send_records)
      .set({ status: "failed", error: INTERRUPTED_ERROR })
      .where(
        and(
          eq(send_records.campaign_id, campaignId),
          eq(send_records.status, "sending"),
        ),
      )
      .returning({ id: send_records.id })
      .all();

    const n = swept.length;
    if (n === 0) return 0; // no orphans → no counter change

    tx.update(campaigns)
      .set({ failed_count: sql`${campaigns.failed_count} + ${n}` })
      .where(eq(campaigns.id, campaignId))
      .run();

    return n;
  });
}
