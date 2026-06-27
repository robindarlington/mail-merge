/**
 * db:migrate runner.
 *
 * Applies the committed Drizzle migrations in ./drizzle to the SQLite file,
 * physically creating the six v1 tables on disk. This is the gate that turns
 * the type-checked schema (plan 01-02) into a REAL database — a passing
 * `tsc`/`next build` does NOT prove the tables exist.
 *
 * It reuses the single lib/db client (D-04): the raw `connection` opened by
 * lib/db/client.ts (with WAL + busy_timeout + synchronous=NORMAL +
 * foreign_keys=ON already applied). It does NOT open a second better-sqlite3
 * handle — lib/db is the only module permitted to open SQLite.
 *
 * WARNING: This script closes the shared connection singleton on exit.
 * Do NOT import this file as a module from application code or tests —
 * doing so would close the connection for all subsequent DB operations
 * in the same process. Run it only as a standalone one-shot script via
 * `tsx scripts/migrate.ts` or `npm run db:migrate`.
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { db, connection } from "../lib/db";

function main(): void {
  const dbPath = process.env.DATABASE_PATH ?? "./data/app.db";
  console.log(`[migrate] applying drizzle migrations to ${dbPath}`);

  try {
    // Apply every pending migration in ./drizzle (idempotent: drizzle tracks
    // applied migrations in its __drizzle_migrations table).
    migrate(db, { migrationsFolder: "./drizzle" });

    console.log("[migrate] migrations applied");

    // Sanity log: list the user tables now present on disk.
    const tables = connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    console.log(
      `[migrate] tables on disk: ${tables.map((t) => t.name).join(", ")}`,
    );
  } finally {
    // Always close the handle so the process exits cleanly, even if migrate()
    // throws (e.g., a malformed migration file). This is safe only because this
    // script runs as a one-shot — see module-level WARNING above.
    connection.close();
  }
}

main();
