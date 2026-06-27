/**
 * THE single SQLite opener (D-04).
 *
 * This is the ONLY module in the codebase permitted to construct a
 * better-sqlite3 Database. Both the Next.js web process and the standalone
 * worker import the `db` instance from here, so they inherit identical pragmas.
 * Setting WAL + busy_timeout in exactly one place is the structural enforcement
 * of the "no SQLITE_BUSY" success criterion (ARCHITECTURE.md Pattern 1,
 * Anti-Pattern 1; STACK.md "Web + worker sharing ONE SQLite file"; PITFALLS #5).
 *
 * Do NOT call `new Database(...)` anywhere else. Import `db` (or the raw
 * `connection`) from `@/lib/db` instead.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

/**
 * Resolve the SQLite file location. DATABASE_PATH is set in prod
 * (Coolify secret → /data/app.db); native dev falls back to ./data/app.db (D-09).
 */
const DATABASE_PATH = resolve(process.env.DATABASE_PATH ?? "./data/app.db");

/**
 * Open the connection once per process and apply the four mandatory pragmas
 * in this exact form (the single place they are configured):
 *   journal_mode = WAL      — many readers + one writer across web/worker
 *   busy_timeout = 5000     — wait, don't throw, on a held write lock
 *   synchronous = NORMAL    — safe with WAL, faster commits
 *   foreign_keys = ON       — enforce the schema's referential integrity
 */
function openConnection(): Database.Database {
  // Ensure the parent directory exists before better-sqlite3 opens the file.
  mkdirSync(dirname(DATABASE_PATH), { recursive: true });

  const conn = new Database(DATABASE_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");
  return conn;
}

/**
 * Module-level singleton. ESM module caching already makes this a per-process
 * singleton; the globalThis guard additionally survives Next.js dev HMR module
 * reloads so we never leak a second handle onto the same file.
 */
const globalForDb = globalThis as unknown as {
  __mailMergeDbConnection?: Database.Database;
};

export const connection: Database.Database =
  globalForDb.__mailMergeDbConnection ?? openConnection();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__mailMergeDbConnection = connection;
}

/** The typed Drizzle client. Import this everywhere; never open the DB elsewhere. */
export const db = drizzle(connection, { schema });

export type Db = typeof db;
