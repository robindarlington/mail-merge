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

import { eq, sql } from "drizzle-orm";

import { db, campaigns } from "@/lib/db";

/**
 * Mark a drained campaign `completed`: stamp `finished_at`, release the lease.
 * Applies even when `failed_count > 0` — a completed run may include per-row
 * failures.
 */
export function markCompleted(campaignId: number): void {
  db.update(campaigns)
    .set({
      status: "completed",
      finished_at: sql`unixepoch()`,
      worker_id: null,
      lease_expires_at: null,
    })
    .where(eq(campaigns.id, campaignId))
    .run();
}

/**
 * Mark a whole-campaign abort `failed`: stamp `finished_at`, release the lease.
 * `reason` is surfaced via the worker's log (no campaign-level error column in the
 * v1 schema). Reserved for pre-send failures (verify/decrypt/config), NOT for
 * individual per-recipient send failures (those stay recorded on send_records).
 */
export function markFailed(campaignId: number, reason: string): void {
  void reason; // logged by the caller; no campaign error column in v1 schema
  db.update(campaigns)
    .set({
      status: "failed",
      finished_at: sql`unixepoch()`,
      worker_id: null,
      lease_expires_at: null,
    })
    .where(eq(campaigns.id, campaignId))
    .run();
}
