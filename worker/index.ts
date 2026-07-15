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

import pino from "pino";

import { db } from "@/lib/db";
import { tick } from "@/lib/worker/loop";

const logger = pino({ base: { component: "worker" } });

/**
 * Config from env with safe defaults (lib/db/client.ts:27 idiom — read
 * process.env.X, fall back to a literal). Numbers go through Number(...) so a
 * string env value becomes a real number; the `??` keeps the default when unset.
 */
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS ?? 1000);
const WORKER_POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const WORKER_LEASE_SEC = Number(process.env.WORKER_LEASE_SEC ?? 300);
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

  // A ref'd interval (NOT unref'd — the real worker must stay alive). Each poll,
  // if we are not stopping and no tick is already running, run one tick and log
  // its outcome. The `inFlight` guard ensures at most one tick per poll so two
  // campaigns are never claimed concurrently by a single worker (T-06-13).
  const interval = setInterval(() => {
    if (stopping || inFlight) return;
    inFlight = true;
    tick({ workerId, leaseSec: WORKER_LEASE_SEC, delayMs: SEND_DELAY_MS })
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
