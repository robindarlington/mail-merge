/**
 * Migration integration tests for the 06.1 multi-SMTP data-model change
 * (0003 additive DDL + 0004 backfill).
 *
 * These prove the migration is safe and correct on a LIVE-shaped volume:
 *
 *  - SC4 (zero user action): a surviving pre-06.1 row is backfilled to
 *    label='Default', is_default=1, deleted_at IS NULL.
 *  - The single-row unique index `smtp_configs_user_uq` is gone and the partial
 *    unique index `smtp_configs_user_default_uq` exists.
 *  - The one-row-per-user invariant is lifted (a second is_default=0 row for the
 *    same user succeeds) while the one-default-per-user invariant holds (a second
 *    is_default=1 row for that user throws on the partial unique index).
 *
 * Method: build the temp DB in its PRE-06.1 shape (post-0002 smtp_configs + the
 * old single-row unique index) and seed ONE row, then apply the COMMITTED 0003
 * and 0004 SQL files verbatim (statement-split on drizzle's breakpoints). This
 * exercises exactly the SQL that will run against the real /data volume.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB BEFORE any DB import -----------------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "smtp-migration-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
// 32-byte key so the app's DB client module loads cleanly (unused by this test).
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic import so the env vars above are in effect at module-eval time.
const { connection } = await import("@/lib/db");

const DRIZZLE_DIR = "./drizzle";
const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";

/** Resolve a migration file by its numeric prefix (tolerates the random slug). */
function migrationFile(prefix: string): string {
  const name = readdirSync(DRIZZLE_DIR).find(
    (f) => f.startsWith(prefix) && f.endsWith(".sql"),
  );
  assert.ok(name, `expected a ${prefix}*.sql migration to exist`);
  return join(DRIZZLE_DIR, name);
}

/** Apply a committed migration file verbatim: split on drizzle breakpoints,
 *  strip SQL comment lines, exec each non-empty statement on the raw handle. */
function applyMigration(prefix: string): void {
  const raw = readFileSync(migrationFile(prefix), "utf8");
  for (const chunk of raw.split("--> statement-breakpoint")) {
    const statement = chunk
      .replace(/^--.*$/gm, "") // drop full-line SQL comments
      .trim();
    if (statement) connection.exec(statement);
  }
}

before(() => {
  // Build smtp_configs in its PRE-06.1 (post-0002) shape + the old single-row
  // unique index, matching lib/db/schema.ts before this plan's change.
  connection.exec(`
    CREATE TABLE \`smtp_configs\` (
      \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      \`user_id\` text NOT NULL,
      \`host\` text NOT NULL,
      \`port\` integer NOT NULL,
      \`secure\` integer NOT NULL,
      \`username\` text NOT NULL,
      \`password_enc\` blob NOT NULL,
      \`password_iv\` blob NOT NULL,
      \`password_tag\` blob NOT NULL,
      \`from_addr\` text NOT NULL,
      \`from_name\` text,
      \`verified_at\` integer,
      \`created_at\` integer DEFAULT (unixepoch()) NOT NULL
    );
  `);
  connection.exec(
    "CREATE UNIQUE INDEX `smtp_configs_user_uq` ON `smtp_configs` (`user_id`);",
  );

  // Seed exactly ONE pre-migration row (the single-server account being upgraded).
  connection
    .prepare(
      `INSERT INTO smtp_configs
         (user_id, host, port, secure, username, password_enc, password_iv, password_tag, from_addr, from_name, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      USER_A,
      "host-a.example",
      587,
      0,
      "host-a-user",
      Buffer.from("enc"),
      Buffer.from("iv"),
      Buffer.from("tag"),
      "noreply@host-a.example",
      "Host A",
      1700000000,
    );

  // Apply the committed 06.1 migrations exactly as the real runner would.
  applyMigration("0003");
  applyMigration("0004");
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("SC4: surviving pre-06.1 row is backfilled to Default / is_default=1 / not deleted", () => {
  const row = connection
    .prepare(
      "SELECT label, is_default, deleted_at FROM smtp_configs WHERE user_id = ?",
    )
    .get(USER_A) as {
    label: string | null;
    is_default: number;
    deleted_at: number | null;
  };
  assert.equal(row.label, "Default");
  assert.ok(row.is_default, "is_default should be truthy (1)");
  assert.equal(row.deleted_at, null);
});

test("old single-row index is gone; partial default index exists", () => {
  const indexes = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  assert.ok(
    !names.includes("smtp_configs_user_uq"),
    "single-row unique index must be dropped",
  );
  assert.ok(
    names.includes("smtp_configs_user_default_uq"),
    "partial one-default-per-user unique index must exist",
  );
});

test("a SECOND non-default row for the same user succeeds (single-row invariant gone)", () => {
  assert.doesNotThrow(() => {
    connection
      .prepare(
        `INSERT INTO smtp_configs
           (user_id, host, port, secure, username, password_enc, password_iv, password_tag, from_addr, from_name, label, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        USER_A,
        "host-a2.example",
        587,
        0,
        "host-a2-user",
        Buffer.from("enc2"),
        Buffer.from("iv2"),
        Buffer.from("tag2"),
        "noreply@host-a2.example",
        "Host A2",
        "Secondary",
      );
  });
  const count = connection
    .prepare("SELECT COUNT(*) AS n FROM smtp_configs WHERE user_id = ?")
    .get(USER_A) as { n: number };
  assert.equal(count.n, 2);
});

test("a SECOND is_default=1 row for the same user throws (partial unique index holds)", () => {
  assert.throws(() => {
    connection
      .prepare(
        `INSERT INTO smtp_configs
           (user_id, host, port, secure, username, password_enc, password_iv, password_tag, from_addr, from_name, label, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        USER_A,
        "host-a3.example",
        587,
        0,
        "host-a3-user",
        Buffer.from("enc3"),
        Buffer.from("iv3"),
        Buffer.from("tag3"),
        "noreply@host-a3.example",
        "Host A3",
        "Third",
      );
  }, /UNIQUE constraint failed/);
});
