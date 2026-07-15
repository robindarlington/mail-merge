/**
 * The atomic job-claim seam — the DB-as-queue win signal (SEND-01 / T-06-01).
 *
 * A background send must survive a worker crash, and two workers must never send
 * to the same recipient. Both guarantees start here: claiming a campaign is a
 * SINGLE `UPDATE campaigns … WHERE id=(subquery) … RETURNING id`. SQLite's
 * single-writer model makes that one statement atomic, so the returned row IS the
 * proof that THIS caller won the claim — there is deliberately NO SELECT-then-
 * UPDATE path (that TOCTOU race would let two workers claim the same campaign).
 *
 * The subquery selects the next claimable campaign — a `queued` one, OR a
 * `running` one whose `lease_expires_at` has passed (a crashed worker's campaign,
 * the stalled-reclaim branch, T-06-03) — oldest `created_at` first (FIFO). On a
 * reclaim `started_at` is preserved via COALESCE so the original start time
 * survives. A future-lease `running` campaign is NOT selected: its owner is alive.
 *
 * Worker tenancy exception (06-RESEARCH.md Pitfall 6): the worker has no Clerk
 * session, so after winning the claim it loads the FULL typed row by id ALONE —
 * the ONE documented read that is not userId-scoped — and derives tenancy from
 * the returned `campaign.userId` downstream. `.sync()` runs the relational query
 * synchronously against the shared better-sqlite3 handle (no second opener, D-04).
 */

import { eq } from "drizzle-orm";

import { db, connection, campaigns, type Campaign } from "@/lib/db";

/**
 * A single atomic UPDATE that flips the next claimable campaign to `running`,
 * stamps the lease + worker + start time, and RETURNs its id. `.get()` yields
 * `{ id }` on a win or `undefined` when nothing is claimable. NEVER split into a
 * SELECT + UPDATE — the single statement is the atomicity guarantee
 * (busy_timeout=5000 in lib/db/client.ts covers writer contention).
 *
 * Prepared lazily + memoized: better-sqlite3 compiles (and validates the table
 * against) the SQL at prepare time, so preparing at module load would fail before
 * the schema exists. Deferring to first call means the migration has already run
 * (the worker migrates before its first tick; tests migrate in `before()`).
 */
const CLAIM_SQL = `
  UPDATE campaigns
     SET status = 'running',
         lease_expires_at = unixepoch() + @leaseSec,
         worker_id = @workerId,
         started_at = COALESCE(started_at, unixepoch())
   WHERE id = (
     SELECT id FROM campaigns
      WHERE status = 'queued'
         OR (status = 'running' AND lease_expires_at < unixepoch())
      ORDER BY created_at
      LIMIT 1
   )
  RETURNING id
`;

let claimStmt: ReturnType<typeof connection.prepare> | undefined;
function getClaimStmt() {
  return (claimStmt ??= connection.prepare(CLAIM_SQL));
}

/**
 * Atomically claim the next queued (or stalled) campaign for `workerId`, leasing
 * it for `leaseSec` seconds. Returns the typed `Campaign` (now `running`) on a
 * win, or `undefined` when nothing is claimable. The returned row is the ONLY
 * win signal — callers must treat `undefined` as "another worker owns it / queue
 * empty" and poll again.
 */
export function claimNextCampaign(
  workerId: string,
  leaseSec: number,
): Campaign | undefined {
  const won = getClaimStmt().get({ workerId, leaseSec }) as
    | { id: number }
    | undefined;
  if (!won) return undefined;

  // Worker-only, non-userId-scoped read: tenancy is derived from campaign.userId.
  return db.query.campaigns
    .findFirst({ where: eq(campaigns.id, won.id) })
    .sync();
}
