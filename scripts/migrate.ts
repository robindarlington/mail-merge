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
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { db, connection } from "../lib/db";

function main(): void {
  const dbPath = process.env.DATABASE_PATH ?? "./data/app.db";
  console.log(`[migrate] applying drizzle migrations to ${dbPath}`);

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

  // Release the handle so the process exits cleanly when run as a one-shot.
  connection.close();
}

main();
