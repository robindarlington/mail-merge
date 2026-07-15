/**
 * lib/worker/process — the per-recipient send loop, `runCampaign`.
 *
 * This is Pattern 3 from the phase research (ARCHITECTURE Pattern 3): after a
 * campaign is claimed and its recipients materialized, walk the `pending`
 * send_records, sending one personalized email each and committing every outcome
 * immediately. It reuses the ALREADY-TESTED send primitives from lib/core
 * (`createSmtpTransport` / `verifyTransport` / `sendOne` / `throttle`) and the
 * crypto/DAL — it re-implements NO transport, merge, or crypto code.
 *
 * Correctness invariants:
 *  - verify-once-per-run (Open Question 2): `verifyTransport` runs ONCE before the
 *    first send of this run; a failure aborts the whole run (no rows sent) so the
 *    caller can mark the campaign failed.
 *  - process 'pending' ONLY, ORDER BY id: a re-claimed campaign re-sends nothing
 *    already 'sent' — no double-send (SEND-06).
 *  - write 'sending' (committed) BEFORE the SMTP await: an orphaned 'sending' row
 *    after a crash is detectable by the recovery sweep (Plan 01).
 *  - one bad recipient never aborts the batch: `sendOne` never throws; each row is
 *    a try/continue via the structured SendResult; failed_count is surfaced
 *    (SEND-04).
 *  - better-sqlite3 is SYNCHRONOUS: a transaction cannot span an `await`. Each
 *    per-row DB write is its OWN statement immediately before/after the await —
 *    the SMTP call is NEVER wrapped in a transaction (06-RESEARCH.md 181/221).
 *
 * SECURITY (T-06-04/05, SMTP-04): the SMTP password is decrypted into a transient
 * local used ONLY to build the transport. It is never assigned to a result field,
 * a send_record, a throw, or a log. Per-row failures store `res.error.message`
 * (a STRING), never a raw Error object (D-06).
 *
 * TENANCY (worker exception, PITFALLS #13): no Clerk session — the owner is
 * derived from `campaign.userId` and the campaign's OWN stamped SMTP config is
 * resolved owner-scoped by id (06.1 multi-server; the userId-only lookup is
 * retired). An unknown/deleted/cross-tenant id resolves to undefined → abort.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { send_records, campaigns, type Campaign } from "@/lib/db/schema";
import { getSmtpConfigByIdForUser } from "@/lib/data";
import { decrypt } from "@/lib/crypto";
import {
  createSmtpTransport,
  verifyTransport,
  sendOne,
  throttle,
  type MailTransport,
} from "@/lib/core";

/**
 * SMTP dial timeouts for the worker's transport (CR-01). Every phase is capped
 * WELL BELOW the default lease (WORKER_LEASE_SEC=300s) so a hung connection
 * surfaces as a per-row failure long before another worker can steal the lease and
 * double-send. Without these, nodemailer's default 600s socketTimeout exceeds the
 * 300s lease. Exported so a test can assert the invariant `max < leaseSec*1000`.
 */
export const WORKER_TRANSPORT_TIMEOUTS = {
  connectionTimeout: 60_000,
  greetingTimeout: 30_000,
  socketTimeout: 120_000,
} as const;

/** Options for a single run of a claimed campaign. */
export interface RunCampaignOptions {
  /** The claiming worker's id — carried for symmetry with the ownership-checked
   *  heartbeat/finalize fences (CR-01); the per-row writes fence on status. */
  workerId?: string;
  /** Inject a stub transport in tests so no real socket is opened. */
  transportOverride?: MailTransport;
  /** Inter-send delay in ms (defaults to 0 — applied BETWEEN sends only). */
  delayMs?: number;
  /** Called once per processed row so the caller can bump the lease (Pattern 4).
   *  May THROW (e.g. LeaseLostError) to abort the run promptly on a stolen lease. */
  onHeartbeat?: (campaignId: number) => void;
  /** Cooperative stop signal checked BEFORE each row. When it returns true the
   *  loop exits cleanly between rows (graceful drain, WR-03) leaving the remaining
   *  rows `pending`; the result carries `stopped:true` so the caller does NOT
   *  finalize the campaign. */
  shouldStop?: () => boolean;
}

/** The result of a run: per-row outcome counts, or a whole-campaign abort. */
export type RunCampaignResult =
  | { ok: true; sent: number; failed: number; stopped?: boolean }
  | { ok: false; reason: string };

/**
 * Verify the campaign's SMTP once, then send every `pending` recipient exactly
 * once, committing each outcome immediately. Reuses lib/core send primitives.
 *
 * @param campaign The claimed campaign (its userId + stamped smtp_config_id drive
 *                 owner-scoped SMTP resolution).
 * @param opts     Injected transport / throttle / heartbeat.
 */
export async function runCampaign(
  campaign: Campaign,
  opts: RunCampaignOptions = {},
): Promise<RunCampaignResult> {
  const delayMs = opts.delayMs ?? 0;

  // Resolve the campaign's OWN stamped SMTP config, owner-scoped by id (06.1) — an
  // unknown/deleted/cross-tenant id resolves to undefined → whole-campaign abort.
  const cfg = await getSmtpConfigByIdForUser(campaign.userId, campaign.smtp_config_id);
  if (!cfg) return { ok: false, reason: "no SMTP config" };

  // Decrypt the AES-256-GCM triple into a TRANSIENT local. It is used ONLY to
  // build the real transport (skipped entirely when a test injects one) and is
  // never assigned to a result, a send_record, a throw, or a log (T-06-04).
  const password = decrypt({
    enc: cfg.password_enc as Buffer,
    iv: cfg.password_iv as Buffer,
    tag: cfg.password_tag as Buffer,
  });
  const transport: MailTransport =
    opts.transportOverride ??
    (createSmtpTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: password },
      // Cap every phase of the SMTP dial WELL BELOW the default lease so a hung
      // connection surfaces as a per-row failure before the lease is stealable
      // and a live-but-slow worker double-sends (CR-01).
      ...WORKER_TRANSPORT_TIMEOUTS,
    }) as unknown as MailTransport);

  const from = cfg.from_name
    ? `${cfg.from_name} <${cfg.from_addr}>`
    : cfg.from_addr;

  try {
    // Verify ONCE before the first send of this run. A failure aborts the run
    // WITHOUT sending anything, returning a reason (never the password).
    try {
      await verifyTransport(transport);
    } catch (err) {
      return { ok: false, reason: (err as Error)?.message ?? String(err) };
    }

    // Process 'pending' rows ONLY, oldest first — the resume/no-double-send guard.
    const pending = await db
      .select()
      .from(send_records)
      .where(
        and(
          eq(send_records.campaign_id, campaign.id),
          eq(send_records.status, "pending"),
        ),
      )
      .orderBy(send_records.id);

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i++) {
      const rec = pending[i];

      // Graceful drain (WR-03): a stop signal (SIGTERM) exits the loop cleanly
      // BETWEEN rows — well inside a container's stop-grace window. The remaining
      // rows stay `pending`; `stopped:true` tells the caller to leave the campaign
      // `running` (lease intact) so the reclaim path resumes the rest. We never
      // finalize a drained campaign, and never mark it failed.
      if (opts.shouldStop?.()) return { ok: true, sent, failed, stopped: true };

      // FENCE the pending→sending transition on its expected prior state (CR-01).
      // If another worker (a live-but-slow original whose lease was stolen, or the
      // new owner) already advanced this row, the `AND status='pending'` predicate
      // matches zero rows — we SKIP it and never re-send an already-delivered row.
      // Committing 'sending' BEFORE the SMTP await also keeps the crash orphan
      // detectable by the recovery sweep.
      const claimedRow = db
        .update(send_records)
        .set({ status: "sending" })
        .where(
          and(
            eq(send_records.id, rec.id),
            eq(send_records.status, "pending"),
          ),
        )
        .returning({ id: send_records.id })
        .all();
      if (claimedRow.length === 0) continue; // row taken by another worker — do NOT send

      // sendOne NEVER throws — a failure comes back as a structured value, so one
      // bad recipient cannot abort the batch (SEND-04). The await is deliberately
      // NOT inside any db.transaction(...) — better-sqlite3 is synchronous.
      const res = await sendOne({
        transport,
        from,
        to: rec.to_addr,
        subject: rec.merged_subject,
        body: rec.merged_body,
      });

      // The terminal row write + counter bump are one synchronous transaction so a
      // crash between them can never desynchronize the counters (WR-04). Each row
      // write is fenced on `status='sending'` (CR-01): if the recovery sweep or the
      // new owner already moved this row terminal, we neither overwrite it nor bump
      // the counter, keeping sent_count/failed_count honest.
      if (res.ok) {
        const written = db.transaction((tx) => {
          const upd = tx
            .update(send_records)
            .set({
              status: "sent",
              message_id: res.messageId,
              sent_at: sql`(unixepoch())`,
            })
            .where(
              and(
                eq(send_records.id, rec.id),
                eq(send_records.status, "sending"),
              ),
            )
            .returning({ id: send_records.id })
            .all();
          if (upd.length === 0) return false;
          tx.update(campaigns)
            .set({ sent_count: sql`${campaigns.sent_count} + 1` })
            .where(eq(campaigns.id, campaign.id))
            .run();
          return true;
        });
        if (written) sent++;
      } else {
        // Store the message STRING only — never a raw Error object (D-06).
        const written = db.transaction((tx) => {
          const upd = tx
            .update(send_records)
            .set({
              status: "failed",
              error: res.error.message,
              attempts: sql`${send_records.attempts} + 1`,
            })
            .where(
              and(
                eq(send_records.id, rec.id),
                eq(send_records.status, "sending"),
              ),
            )
            .returning({ id: send_records.id })
            .all();
          if (upd.length === 0) return false;
          tx.update(campaigns)
            .set({ failed_count: sql`${campaigns.failed_count} + 1` })
            .where(eq(campaigns.id, campaign.id))
            .run();
          return true;
        });
        if (written) failed++;
      }

      // Heartbeat (lease bump hook) each row — it also PROVES ownership and throws
      // LeaseLostError when the lease was stolen, aborting the run promptly (CR-01).
      // Then throttle BETWEEN sends only.
      opts.onHeartbeat?.(campaign.id);
      if (i < pending.length - 1) await throttle(delayMs);
    }

    return { ok: true, sent, failed };
  } finally {
    // Never leak the socket. A stub transport has no close() — guard it.
    const closable = transport as { close?: () => void };
    if (typeof closable.close === "function") closable.close();
  }
}
