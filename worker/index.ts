/**
 * Standalone worker entrypoint — the composition root (D-02, SEND-01, SEND-06).
 *
 * This is the process the `worker` npm script (`tsx worker/index.ts`) and the
 * Docker Compose `worker` service run. Phase 1 shipped a no-op readiness skeleton;
 * Phase 6 replaces its body with the REAL long-lived loop: a pino logger, an
 * env-configured poll interval that calls the composed `tick()` from
 * lib/worker/loop, an overlap guard so at most one tick runs per poll, and a
 * SIGTERM/SIGINT handler that stops claiming new work and drains the in-flight
 * tick before exiting 0.
 *
 * Logging discipline (PITFALLS #1/#2, T-06-12): pino logs readiness + per-tick
 * outcomes ONLY. It NEVER logs a credential, the SMTP config, or a send body; caught
 * tick errors log the message STRING only, never a raw Error carrying config.
 *
 * Signal safety (T-06-11): SIGTERM (Coolify/Docker stop) sets a `stopping` flag —
 * the loop stops CLAIMING new campaigns and lets the current tick finish. Every
 * send_record is committed synchronously (Plan 02), so even a hard SIGKILL is
 * recoverable via the Plan 01 orphan sweep on the next claim.
 */

import { unlinkSync } from "node:fs";

import pino from "pino";

import { db, connection } from "@/lib/db";
import { tick } from "@/lib/worker/loop";
import {
  checkpointWal,
  sweepOrphanAttachments,
  isDue,
} from "@/lib/worker/maintenance";

const logger = pino({ base: { component: "worker" } });

/**
 * Parse a positive-integer env var with a safe default (WR-06). Fail-closed: an
 * UNSET var uses the default, but a SET-but-malformed value (`abc`, `-5`, `0`,
 * empty) is REJECTED with a startup error and exit(1) rather than silently
 * degrading to NaN — which would otherwise hot-spin the poll loop (NaN interval),
 * blast SMTP with zero throttle, or produce a NULL, never-reclaimable lease. The
 * error logs the var NAME only, never the value (secret-safe discipline).
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.error(
      { name },
      "invalid worker env value — must be a positive number; refusing to start",
    );
    process.exit(1);
  }
  return n;
}

const SEND_DELAY_MS = envInt("SEND_DELAY_MS", 1000);
const WORKER_POLL_MS = envInt("WORKER_POLL_MS", 2000);
const WORKER_LEASE_SEC = envInt("WORKER_LEASE_SEC", 300);
// Idle-aware maintenance cadences (SC-4 / RESEARCH Finding 4). Low frequency,
// env-tunable via the same fail-closed envInt helper. Defaults: hourly checkpoint,
// hourly orphan sweep, 7-day orphan age threshold. No cron, no new deps.
const WAL_CHECKPOINT_MS = envInt("WAL_CHECKPOINT_MS", 3_600_000);
const ORPHAN_SWEEP_MS = envInt("ORPHAN_SWEEP_MS", 3_600_000);
const ATTACHMENT_ORPHAN_DAYS = envInt("ATTACHMENT_ORPHAN_DAYS", 7);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

function main(): void {
  // Touch the shared client so the worker shares the WAL'd connection the web
  // process uses (the single opener, D-04). A trivial reference proves it loaded.
  void db;

  // Single structured readiness line — component:"worker", no credentials.
  logger.info(
    { workerId, pollMs: WORKER_POLL_MS, leaseSec: WORKER_LEASE_SEC },
    "worker ready",
  );

  let stopping = false;
  let inFlight = false;
  // Maintenance cadence stamps (ms). Start at 0 so a freshly-started worker runs
  // one checkpoint + sweep on its first idle poll — this keeps the routines
  // effective even when frequent redeploys restart the worker before an hour
  // elapses (the exact "WAL grows unbounded between restarts" case, Finding 4).
  let lastCheckpointAt = 0;
  let lastSweepAt = 0;

  // A ref'd interval (NOT unref'd — the real worker must stay alive). Each poll,
  // if we are not stopping and no tick is already running, run one tick and log
  // its outcome. The `inFlight` guard ensures at most one tick per poll so two
  // campaigns are never claimed concurrently by a single worker (T-06-13).
  const interval = setInterval(() => {
    if (stopping || inFlight) return;

    // IDLE MAINTENANCE BRANCH (SC-4). We are provably idle here — `!stopping &&
    // !inFlight` — so the worker is the single writer with no tick in flight
    // (T-08-10). Run the two low-cadence routines when due, SYNCHRONOUSLY and
    // BEFORE claiming any campaign, so they never overlap a send tick and never
    // sit in the drain path (we already returned above when `stopping`). A
    // maintenance failure logs its message only and never crashes the poll loop.
    try {
      const nowMs = Date.now();
      if (isDue(lastCheckpointAt, WAL_CHECKPOINT_MS, nowMs)) {
        checkpointWal(connection, logger);
        lastCheckpointAt = nowMs;
      }
      if (isDue(lastSweepAt, ORPHAN_SWEEP_MS, nowMs)) {
        sweepOrphanAttachments({
          db,
          now: Math.floor(nowMs / 1000),
          orphanDays: ATTACHMENT_ORPHAN_DAYS,
          unlink: unlinkSync,
          logger,
        });
        lastSweepAt = nowMs;
      }
    } catch (err: unknown) {
      // Message STRING only — never a raw Error that could carry config (T-06-12).
      logger.error(
        { err: (err as Error)?.message ?? String(err) },
        "maintenance error",
      );
    }

    inFlight = true;
    // Thread the stop flag so a SIGTERM drains BETWEEN rows (WR-03) rather than
    // waiting for a whole campaign's tick — the graceful path stays inside the
    // container stop-grace window.
    tick({
      workerId,
      leaseSec: WORKER_LEASE_SEC,
      delayMs: SEND_DELAY_MS,
      shouldStop: () => stopping,
    })
      .then((result) => {
        if (result.claimed && result.outcome === "completed") {
          logger.info(
            { campaignId: result.campaignId, sent: result.sent, failed: result.failed },
            "campaign completed",
          );
        } else if (result.claimed && result.outcome === "failed") {
          logger.warn(
            { campaignId: result.campaignId, reason: result.reason },
            "campaign failed",
          );
        } else if (result.claimed && result.outcome === "aborted") {
          logger.warn(
            { campaignId: result.campaignId, reason: result.reason },
            "campaign aborted — lease reclaimed by another worker",
          );
        } else if (result.claimed && result.outcome === "stopped") {
          logger.info(
            { campaignId: result.campaignId, sent: result.sent, failed: result.failed },
            "campaign drain-stopped — remaining rows left pending for resume",
          );
        }
        // result.claimed === false → no work this poll; stay quiet.
      })
      .catch((err: unknown) => {
        // Log the message STRING only — never the raw Error object (T-06-12).
        logger.error({ err: (err as Error)?.message ?? String(err) }, "tick error");
      })
      .finally(() => {
        inFlight = false;
        // If a stop arrived while this tick was draining, exit now that it is done.
        if (stopping) process.exit(0);
      });
  }, WORKER_POLL_MS);

  // SIGTERM (Docker/Coolify stop) + SIGINT (Ctrl-C): stop claiming new work, let
  // any in-flight tick finish, then exit cleanly. Never corrupt mid-batch state.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      stopping = true;
      clearInterval(interval);
      logger.info({ signal: sig }, "worker stopping — draining in-flight tick");
      // If nothing is in flight, exit immediately; otherwise the tick's `finally`
      // exits once it finishes.
      if (!inFlight) process.exit(0);
    });
  }
}

main();
