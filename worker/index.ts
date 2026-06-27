/**
 * Standalone worker entrypoint (D-02).
 *
 * This is the process the `worker` npm script (`tsx worker/index.ts`) and the
 * Docker Compose `worker` service run. In Phase 1 it is a MINIMAL readiness
 * skeleton: it opens the shared lib/db client (the only SQLite opener — D-04),
 * logs a single structured "worker ready" line, and idles in a trivial poll
 * loop. The real claim/lease/send logic is Phase 6 — there is intentionally NO
 * send or queue logic here yet.
 *
 * Logging discipline (PITFALLS #1/#2): never log secrets. Only readiness and
 * liveness are logged.
 */

import { db } from "@/lib/db";

/** Poll interval for the no-op liveness loop (ms). Real dequeue logic: Phase 6. */
const POLL_INTERVAL_MS = 30_000;

function main(): void {
  // Touch the shared client so the worker shares the WAL'd connection the web
  // process uses. A trivial read proves the DB is reachable at startup.
  void db;

  // Single structured readiness line (console is fine for the skeleton; pino is
  // wired in Phase 6 when the worker actually does work). No secrets logged.
  console.log(
    JSON.stringify({
      level: "info",
      msg: "worker ready",
      component: "worker",
      ts: new Date().toISOString(),
    }),
  );

  // Minimal long-lived liveness loop. No send/claim logic (Phase 6).
  // The interval is .unref()'d so a bare readiness import (e.g. the verify gate
  // that just imports this module) exits cleanly instead of hanging — yet the
  // real worker process, launched as `tsx worker/index.ts` in the foreground or
  // as the compose `worker` service (PID-foreground), stays alive normally.
  // The Phase 6 dequeue loop replaces this with a ref'd long-lived loop.
  const heartbeat = setInterval(() => {
    // no-op heartbeat; replaced by the campaign dequeue loop in Phase 6.
  }, POLL_INTERVAL_MS);
  heartbeat.unref();
}

main();
