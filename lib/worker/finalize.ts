/**
 * Campaign terminal-transition seams (Pattern 5 / Pitfall 5 / A5).
 *
 * Two mutually-exclusive ways a claimed campaign leaves `running`:
 *
 *  - markCompleted: the send loop drained every `pending` row. This is `completed`
 *    EVEN when some rows failed — a partial failure is still a completed RUN
 *    (success criterion: "failures don't abort the batch"). `failed_count` is left
 *    as-is so the history UI can show "97 sent / 3 failed" on a completed campaign.
 *
 *  - markFailed: a WHOLE-CAMPAIGN abort before (or independent of) per-row sends —
 *    e.g. transport.verify() failed, SMTP config missing, or a decrypt error. The
 *    `reason` is for the worker's structured log (there is no campaign error column
 *    in the v1 schema — no schema change this phase).
 *
 * Both stamp `finished_at = unixepoch()` and RELEASE the lease (`worker_id` and
 * `lease_expires_at` → NULL) so a terminal campaign can never be re-selected by the
 * stalled-lease branch of claimNextCampaign (T-06-03). Each is a single
 * `UPDATE campaigns … WHERE id=?` on the shared drizzle `db` (no new opener, D-04).
 */

import { and, eq, sql } from "drizzle-orm";

import { db, campaigns } from "@/lib/db";

/**
 * Mark a drained campaign `completed`: stamp `finished_at`, release the lease.
 * Applies even when `failed_count > 0` — a completed run may include per-row
 * failures.
 *
 * OWNERSHIP FENCE (CR-01): the terminal write only lands when this worker still
 * owns the lease (`worker_id = ?`). If the lease was stolen by another worker
 * (stalled-reclaim after a hung socket), the `AND worker_id = ?` predicate matches
 * zero rows so a stale worker can NEVER stomp the new owner's `running` state.
 * Returns the number of rows written (0 = the claim was lost).
 */
export function markCompleted(campaignId: number, workerId: string): number {
  const done = db
    .update(campaigns)
    .set({
      status: "completed",
      finished_at: sql`unixepoch()`,
      worker_id: null,
      lease_expires_at: null,
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.worker_id, workerId)))
    .returning({ id: campaigns.id })
    .all();
  return done.length;
}

/**
 * Mark a whole-campaign abort `failed`: stamp `finished_at`, release the lease.
 * `reason` is surfaced via the worker's log (no campaign-level error column in the
 * v1 schema). Reserved for pre-send failures (verify/decrypt/config/materialize),
 * NOT for individual per-recipient send failures (those stay recorded on
 * send_records).
 *
 * OWNERSHIP FENCE (CR-01): like markCompleted, the write is gated on
 * `worker_id = ?` so a stale worker whose lease was reclaimed cannot flip the new
 * owner's `running` campaign to `failed`. Returns rows written (0 = claim lost).
 */
export function markFailed(
  campaignId: number,
  reason: string,
  workerId: string,
): number {
  void reason; // logged by the caller; no campaign error column in v1 schema
  const done = db
    .update(campaigns)
    .set({
      status: "failed",
      finished_at: sql`unixepoch()`,
      worker_id: null,
      lease_expires_at: null,
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.worker_id, workerId)))
    .returning({ id: campaigns.id })
    .all();
  return done.length;
}
