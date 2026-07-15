/**
 * lib/worker/loop — the composed single-poll unit of work, `tick()`.
 *
 * This is the composition seam of the background sender: every poll, `tick`
 * claims the next campaign and, on a win, runs the full crash-safe lifecycle in
 * order — recover orphans → materialize recipients → run the send loop → finalize
 * the campaign. The five underlying seams (Plans 01 + 02) already carry every
 * correctness guarantee; this file only WIRES them, with all side-effecting deps
 * (transport override, delay, lease) injected through `opts` so the test can drive
 * the whole machine with a stub transport and zero throttle.
 *
 * Ordering is load-bearing (06-RESEARCH Pattern 6):
 *  1. claimNextCampaign — the atomic DB-as-queue win signal; `undefined` = no work.
 *  2. recoverOrphanedSending — on a RE-claim, sweep any 'sending' row left by a
 *     crashed worker to a terminal 'failed'(interrupted) so it is never re-sent
 *     (SEND-06 no-double-send). A no-op on a first claim (0 orphans).
 *  3. materializeSendRecords — idempotent: inserts only the rows this campaign is
 *     missing (onConflictDoNothing), so a resume adds nothing.
 *  4. runCampaign — verify-once then send only 'pending' rows, committing each
 *     outcome; a `{ ok:false, reason }` is a whole-campaign abort.
 *  5. markCompleted (on ok) / markFailed (on !ok) — the terminal transition that
 *     releases the lease (06-RESEARCH verify-abort → markFailed 375-378, A5).
 *
 * Lease heartbeat (Pattern 4): `onHeartbeat` fires once per processed row and
 * bumps the campaign's lease so a long batch is never mistaken for a crashed
 * worker and stolen by another claim mid-send. A single UPDATE, no new opener (D-04).
 */

import { eq, sql } from "drizzle-orm";

import { db, campaigns, type Campaign } from "@/lib/db";
import type { MailTransport } from "@/lib/core";
import { claimNextCampaign } from "@/lib/worker/claim";
import { recoverOrphanedSending } from "@/lib/worker/recover";
import { materializeSendRecords } from "@/lib/worker/materialize";
import { runCampaign } from "@/lib/worker/process";
import { markCompleted, markFailed } from "@/lib/worker/finalize";

/** Options for a single poll tick — all side-effecting deps injected. */
export interface TickOptions {
  /** Identifies this worker on the claim (stamped into campaigns.worker_id). */
  workerId: string;
  /** Lease length in seconds — the claim window and the per-row heartbeat bump. */
  leaseSec: number;
  /** Inter-send throttle in ms (applied BETWEEN sends only; 0 in tests). */
  delayMs: number;
  /** Inject a stub transport in tests so no real socket is opened. */
  transportOverride?: MailTransport;
}

/** The summary of one tick: no work, a completed run, or a whole-campaign abort. */
export type TickResult =
  | { claimed: false }
  | { claimed: true; campaignId: number; outcome: "completed"; sent: number; failed: number }
  | { claimed: true; campaignId: number; outcome: "failed"; reason: string };

/**
 * Claim the next campaign and drive its full lifecycle. Returns `{ claimed:false }`
 * when the queue is empty (poll again later), a completed summary with per-row
 * counts on success, or a `failed` summary carrying the abort reason.
 */
export async function tick(opts: TickOptions): Promise<TickResult> {
  const campaign = claimNextCampaign(opts.workerId, opts.leaseSec);
  if (!campaign) return { claimed: false };

  // Re-claim recovery: sweep any orphaned 'sending' rows terminal BEFORE sending,
  // so a crashed worker's in-flight row is never re-delivered (no-op on first claim).
  recoverOrphanedSending(campaign.id);

  // Idempotent materialize: inserts only missing rows (no-op on a resume).
  await materializeSendRecords(campaign);

  // Per-row lease bump so a long batch keeps its claim (Pattern 4).
  const onHeartbeat = (campaignId: number) => bumpLease(campaignId, opts.leaseSec);

  const r = await runCampaign(campaign, {
    transportOverride: opts.transportOverride,
    delayMs: opts.delayMs,
    onHeartbeat,
  });

  if (r.ok) {
    markCompleted(campaign.id);
    return {
      claimed: true,
      campaignId: campaign.id,
      outcome: "completed",
      sent: r.sent,
      failed: r.failed,
    };
  }

  markFailed(campaign.id, r.reason);
  return { claimed: true, campaignId: campaign.id, outcome: "failed", reason: r.reason };
}

/**
 * Extend a running campaign's lease to `now + leaseSec`. A single UPDATE on the
 * shared drizzle `db` (no new opener, D-04) — called once per sent row so a long
 * batch is not mistaken for a crashed worker and reclaimed mid-send.
 */
function bumpLease(campaignId: number, leaseSec: number): void {
  db.update(campaigns)
    .set({ lease_expires_at: sql`unixepoch() + ${leaseSec}` })
    .where(eq(campaigns.id, campaignId))
    .run();
}

export type { Campaign };
