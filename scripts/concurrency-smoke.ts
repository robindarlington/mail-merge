/**
 * TWO-PROCESS concurrency smoke test — empirical proof of success criterion #1
 * (no SQLITE_BUSY under simultaneous cross-process read + write).
 *
 * WHY TWO REAL OS PROCESSES (not a same-process async loop):
 *   better-sqlite3 is SYNCHRONOUS. Every statement blocks the event loop until
 *   it returns, so a single Node process can NEVER have two of its own
 *   statements mid-flight at once — it can never observe SQLITE_BUSY against
 *   itself. SQLITE_BUSY only arises when a SEPARATE OS process holds the write
 *   lock while another wants it. A same-process `Promise.all` simulation would
 *   pass trivially and prove NOTHING. So this test FORKS a second OS-level
 *   process (child_process.fork) that opens its OWN better-sqlite3 connection
 *   THROUGH the shared lib/db client and contends for the same WAL'd app.db.
 *
 * DESIGN:
 *   - The CHILD (role=writer) runs many short INSERT/UPDATE transactions on a
 *     scratch table in a tight loop.
 *   - The PARENT (role=reader) runs many SELECTs against the same table,
 *     overlapping in wall-clock time with the child's writes.
 *   - A separate writer-vs-writer pass also runs so two processes contend for
 *     the single SQLite writer slot (the case busy_timeout actually guards).
 *   - Each process captures any "SQLITE_BUSY" / "database is locked" error.
 *
 * A GREEN run (exit 0, no lock errors in EITHER process) proves the WAL +
 * busy_timeout=5000 single-client config (set once in lib/db/client.ts, D-04)
 * makes contended cross-process writes WAIT rather than throw — the empirical
 * proof behind the structural guarantee established in plan 01-02.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { connection } from "@/lib/db";

/** Scratch table used purely for the contention probe (no FKs, dropped/created idempotently). */
const SCRATCH_DDL = `
  CREATE TABLE IF NOT EXISTS _concurrency_probe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker TEXT NOT NULL,
    n INTEGER NOT NULL,
    ts INTEGER NOT NULL
  );
`;

const ITERATIONS = 400;
const LOCK_PATTERN = /SQLITE_BUSY|database is locked/i;

/** Run a tight loop of short write transactions through the shared connection. */
function runWriter(label: string): void {
  connection.exec(SCRATCH_DDL);
  const insert = connection.prepare(
    "INSERT INTO _concurrency_probe (worker, n, ts) VALUES (?, ?, ?)",
  );
  const update = connection.prepare(
    "UPDATE _concurrency_probe SET ts = ? WHERE id = ?",
  );
  const tx = connection.transaction((n: number) => {
    const info = insert.run(label, n, Date.now());
    update.run(Date.now(), info.lastInsertRowid as number);
  });
  for (let i = 0; i < ITERATIONS; i++) {
    tx(i);
  }
}

/** Run a tight loop of SELECTs through the shared connection. */
function runReader(label: string): void {
  connection.exec(SCRATCH_DDL);
  const select = connection.prepare(
    "SELECT COUNT(*) AS c FROM _concurrency_probe",
  );
  const recent = connection.prepare(
    "SELECT id, worker, n, ts FROM _concurrency_probe ORDER BY id DESC LIMIT 5",
  );
  for (let i = 0; i < ITERATIONS; i++) {
    select.get();
    recent.all();
  }
  void label;
}

/**
 * CHILD process entry. Selected via the CONCURRENCY_ROLE env var that the parent
 * sets when forking. The child opens its OWN connection (this is a separate OS
 * process) through @/lib/db, so two real processes contend for the same file.
 */
function childMain(role: string): void {
  try {
    if (role === "writer") {
      runWriter("child-writer");
    } else {
      runReader("child-reader");
    }
    console.log(`[child:${role}] done, no lock errors`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Print to stderr so the parent can scan for the lock pattern.
    console.error(`[child:${role}] ERROR: ${msg}`);
    process.exit(LOCK_PATTERN.test(msg) ? 2 : 1);
  }
}

/** Fork one child running the given role; resolve with its exit code + captured stderr. */
function forkRole(
  selfPath: string,
  role: "writer" | "reader",
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = fork(selfPath, [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, CONCURRENCY_ROLE: role },
      stdio: ["inherit", "inherit", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      resolvePromise({ code: code ?? 0, stderr });
    });
  });
}

/**
 * PARENT process entry. Forks a second OS process and runs an overlapping
 * workload in this process at the same time, then joins and asserts no
 * SQLITE_BUSY appeared in either process.
 */
async function parentMain(selfPath: string): Promise<void> {
  console.log(
    "[concurrency-smoke] starting TWO-PROCESS probe (parent + forked child)",
  );

  const parentErrors: string[] = [];

  // PASS 1: child WRITER contends with parent READER (WAL many-readers/one-writer).
  // PASS 2: child WRITER contends with parent WRITER (two processes fight for the
  //         single SQLite writer slot — the exact case busy_timeout must absorb).
  const childWriter1 = forkRole(selfPath, "writer");
  try {
    runReader("parent-reader");
  } catch (err) {
    parentErrors.push(err instanceof Error ? err.message : String(err));
  }
  const res1 = await childWriter1;

  const childWriter2 = forkRole(selfPath, "writer");
  try {
    runWriter("parent-writer");
  } catch (err) {
    parentErrors.push(err instanceof Error ? err.message : String(err));
  }
  const res2 = await childWriter2;

  // Assertions: both child processes exited 0; no lock pattern in any output.
  const failures: string[] = [];

  for (const [name, res] of [
    ["child-writer-pass1", res1],
    ["child-writer-pass2", res2],
  ] as const) {
    if (res.code !== 0) {
      failures.push(`${name} exited non-zero (code ${res.code})`);
    }
    if (LOCK_PATTERN.test(res.stderr)) {
      failures.push(`${name} reported a lock error: ${res.stderr.trim()}`);
    }
  }

  for (const parentError of parentErrors) {
    if (LOCK_PATTERN.test(parentError)) {
      failures.push(`parent reported a lock error: ${parentError}`);
    } else {
      failures.push(`parent errored: ${parentError}`);
    }
  }

  if (failures.length > 0) {
    console.error("[concurrency-smoke] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  // Clean up the scratch table so reruns start fresh-ish (harmless if it stays).
  try {
    connection.exec("DROP TABLE IF EXISTS _concurrency_probe");
  } catch {
    // ignore cleanup errors
  }

  console.log(
    "[concurrency-smoke] PASSED — two real OS processes ran overlapping " +
      "read+write against the WAL'd app.db with NO SQLITE_BUSY (criterion #1).",
  );
  process.exit(0);
}

// Dispatch: a forked child carries CONCURRENCY_ROLE; the top-level invocation
// (no role) is the parent that orchestrates the two-process probe.
const selfPath = fileURLToPath(import.meta.url);
const role = process.env.CONCURRENCY_ROLE;
if (role) {
  childMain(role);
} else {
  void parentMain(selfPath);
}
