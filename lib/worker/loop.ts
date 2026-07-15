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

import { and, eq, sql } from "drizzle-orm";

import { db, campaigns, type Campaign } from "@/lib/db";
import type { MailTransport } from "@/lib/core";
import { claimNextCampaign } from "@/lib/worker/claim";
import { recoverOrphanedSending } from "@/lib/worker/recover";
import { materializeSendRecords } from "@/lib/worker/materialize";
import { runCampaign } from "@/lib/worker/process";
import { markCompleted, markFailed } from "@/lib/worker/finalize";

/**
 * Thrown by the ownership-checked heartbeat when a lease bump matches zero rows —
 * i.e. another worker reclaimed this campaign (the stalled-lease branch fired
 * after a hung socket). The run aborts WITHOUT finalizing: the new owner is now
 * authoritative and this stale worker must never write to the campaign again.
 */
export class LeaseLostError extends Error {
  constructor(campaignId: number) {
    super(`lease lost for campaign ${campaignId}`);
    this.name = "LeaseLostError";
  }
}

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
  /** Cooperative stop signal (SIGTERM) checked between rows for a graceful drain
   *  (WR-03). When it trips mid-batch the campaign is left `running` for the
   *  reclaim path to resume; the tick reports outcome "stopped". */
  shouldStop?: () => boolean;
}

/** The summary of one tick: no work, a completed run, or a whole-campaign abort. */
export type TickResult =
  | { claimed: false }
  | { claimed: true; campaignId: number; outcome: "completed"; sent: number; failed: number }
  | { claimed: true; campaignId: number; outcome: "failed"; reason: string }
  | { claimed: true; campaignId: number; outcome: "aborted"; reason: string }
  | { claimed: true; campaignId: number; outcome: "stopped"; sent: number; failed: number };

/**
 * Claim the next campaign and drive its full lifecycle. Returns `{ claimed:false }`
 * when the queue is empty (poll again later), a completed summary with per-row
 * counts on success, or a `failed` summary carrying the abort reason.
 */
export async function tick(opts: TickOptions): Promise<TickResult> {
  const campaign = claimNextCampaign(opts.workerId, opts.leaseSec);
  if (!campaign) return { claimed: false };

  // Every post-claim failure MUST be terminal (CR-02). materialize throws on a
  // deleted CSV, an unresolvable email column, or a missing recipient set/template;
  // recover could throw on a DB fault. Without this catch the campaign sits
  // 'running' until its lease expires, gets reclaimed, throws again — an infinite
  // claim→throw→reclaim loop with the UI spinning "Sending" forever. Instead we
  // mark it failed so it reaches a terminal state and frees the FIFO queue.
  try {
    // Re-claim recovery: sweep any orphaned 'sending' rows terminal BEFORE sending,
    // so a crashed worker's in-flight row is never re-delivered (no-op on first claim).
    recoverOrphanedSending(campaign.id);

    // Idempotent materialize: inserts only missing rows (no-op on a resume).
    await materializeSendRecords(campaign);
  } catch (e) {
    const reason = (e as Error)?.message ?? String(e);
    markFailed(campaign.id, reason, opts.workerId);
    return { claimed: true, campaignId: campaign.id, outcome: "failed", reason };
  }

  // Per-row lease bump so a long batch keeps its claim (Pattern 4). The bump is
  // ownership-checked: if it matches zero rows the lease was stolen, so it throws
  // LeaseLostError and the run aborts before sending another row (CR-01).
  const onHeartbeat = (campaignId: number) =>
    bumpLease(campaignId, opts.workerId, opts.leaseSec);

  let r;
  try {
    r = await runCampaign(campaign, {
      workerId: opts.workerId,
      transportOverride: opts.transportOverride,
      delayMs: opts.delayMs,
      onHeartbeat,
      shouldStop: opts.shouldStop,
    });
  } catch (e) {
    if (e instanceof LeaseLostError) {
      // The lease was reclaimed mid-run by another worker. Do NOT finalize — the
      // new owner is authoritative; touching the campaign here would double-send
      // or stomp its state. Abort quietly and let the new owner drive it.
      return {
        claimed: true,
        campaignId: campaign.id,
        outcome: "aborted",
        reason: e.message,
      };
    }
    throw e;
  }

  if (r.ok && r.stopped) {
    // Graceful drain (WR-03): the loop stopped between rows. Leave the campaign
    // `running` with its lease intact — do NOT finalize — so the reclaim path
    // resumes the remaining `pending` rows on the next claim.
    return {
      claimed: true,
      campaignId: campaign.id,
      outcome: "stopped",
      sent: r.sent,
      failed: r.failed,
    };
  }

  if (r.ok) {
    markCompleted(campaign.id, opts.workerId);
    return {
      claimed: true,
      campaignId: campaign.id,
      outcome: "completed",
      sent: r.sent,
      failed: r.failed,
    };
  }

  markFailed(campaign.id, r.reason, opts.workerId);
  return { claimed: true, campaignId: campaign.id, outcome: "failed", reason: r.reason };
}

/**
 * Extend a running campaign's lease to `now + leaseSec`, PROVING ownership in the
 * same statement (`AND worker_id = ?`). A single UPDATE on the shared drizzle `db`
 * (no new opener, D-04) — called once per sent row so a long batch is not mistaken
 * for a crashed worker and reclaimed mid-send.
 *
 * When the bump matches zero rows the lease was stolen (another worker reclaimed
 * the stalled campaign): we throw LeaseLostError so the caller aborts the run
 * before sending another row, preventing the live-but-slow worker from
 * double-sending (CR-01).
 */
function bumpLease(campaignId: number, workerId: string, leaseSec: number): void {
  const bumped = db
    .update(campaigns)
    .set({ lease_expires_at: sql`unixepoch() + ${leaseSec}` })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.worker_id, workerId)))
    .returning({ id: campaigns.id })
    .all();
  if (bumped.length === 0) throw new LeaseLostError(campaignId);
}

export type { Campaign };
