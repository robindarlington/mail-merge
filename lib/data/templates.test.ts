/**
 * Cross-tenant isolation tests for the templates DAL (EDIT-04 / AUTH-02 / T-4-IDOR).
 *
 * These prove the tenancy invariant structurally: User A can never read User B's
 * template, and every list/read is owner-scoped. `getTemplateForUser` has no
 * fetch-by-id-alone path, so an id owned by User A returns undefined when queried
 * as User B (the EDIT-04 IDOR assertion). Ownership on write is server-injected —
 * a caller can never spoof `userId` through the values object (T-4-TAMPER-OWNER).
 *
 * Pattern (mirrors lib/data/recipients.test.ts): set a temp `DATABASE_PATH` BEFORE
 * dynamically importing anything that transitively opens the DB
 * (lib/db/client.ts resolves DATABASE_PATH at module load), then build the schema
 * on that throwaway file via the committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB BEFORE any DB import -----------------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "templates-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");

// Dynamic imports so the env var above is in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { createTemplate, listTemplatesForUser, getTemplateForUser } =
  await import("./templates");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

// Ids captured during seeding for the ownership/ordering assertions.
let A_FIRST_ID = 0;
let A_SECOND_ID = 0;
let B_ID = 0;

before(async () => {
  // Build all tables (and indexes) on the temp DB from committed migrations.
  migrate(db, { migrationsFolder: "./drizzle" });

  const [aFirst] = await createTemplate(USER_A, {
    subject: "Hi {{name}}",
    body: "Welcome aboard.",
  });
  const [aSecond] = await createTemplate(USER_A, {
    subject: "Second {{name}}",
    body: "Follow-up message.",
  });
  const [b] = await createTemplate(USER_B, {
    subject: "B only",
    body: "This is User B's template.",
  });

  A_FIRST_ID = aFirst.id;
  A_SECOND_ID = aSecond.id;
  B_ID = b.id;

  // created_at defaults to unixepoch() seconds; two inserts in the same second
  // tie, which would make newest-first ordering non-deterministic. Force distinct
  // timestamps so the desc(created_at) ordering assertion is stable.
  connection
    .prepare("UPDATE templates SET created_at = ? WHERE id = ?")
    .run(1000, A_FIRST_ID);
  connection
    .prepare("UPDATE templates SET created_at = ? WHERE id = ?")
    .run(2000, A_SECOND_ID);
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("createTemplate persists the server-supplied userId and returns the new row", async () => {
  const [row] = await createTemplate(USER_A, {
    subject: "Extra {{name}}",
    body: "Extra body.",
  });
  assert.ok(row.id, "returned row carries a generated id");
  assert.equal(row.userId, USER_A, "userId is the server-supplied caller id");
  assert.equal(row.subject, "Extra {{name}}");
  assert.equal(row.body, "Extra body.");
});

test("listTemplatesForUser returns only the caller's templates, newest first", async () => {
  const aTemplates = await listTemplatesForUser(USER_A);
  // Every returned row belongs to USER_A — USER_B's template never appears.
  assert.ok(
    aTemplates.every((t) => t.userId === USER_A),
    "list is scoped to the caller",
  );
  assert.ok(
    !aTemplates.some((t) => t.id === B_ID),
    "User B's template is never in User A's list",
  );

  // Newest-first: a-second (created_at 2000) precedes a-first (created_at 1000).
  const firstIdx = aTemplates.findIndex((t) => t.id === A_FIRST_ID);
  const secondIdx = aTemplates.findIndex((t) => t.id === A_SECOND_ID);
  assert.ok(secondIdx !== -1 && firstIdx !== -1);
  assert.ok(
    secondIdx < firstIdx,
    "newest (a-second) sorts before older (a-first)",
  );
});

test("listTemplatesForUser for User B never returns User A's templates", async () => {
  const bTemplates = await listTemplatesForUser(USER_B);
  assert.ok(bTemplates.every((t) => t.userId === USER_B));
  assert.ok(!bTemplates.some((t) => t.id === A_FIRST_ID || t.id === A_SECOND_ID));
});

test("getTemplateForUser returns the row for its owner", async () => {
  const row = await getTemplateForUser(USER_A, A_FIRST_ID);
  assert.ok(row, "owner can read their own template");
  assert.equal(row.id, A_FIRST_ID);
  assert.equal(row.userId, USER_A);
});

test("getTemplateForUser blocks cross-tenant reads (IDOR)", async () => {
  // User B supplies an id that belongs to User A — must get undefined, never A's row.
  const leaked = await getTemplateForUser(USER_B, A_FIRST_ID);
  assert.equal(leaked, undefined, "cross-tenant read returns undefined");
});

test("getTemplateForUser returns undefined for a non-existent id", async () => {
  const none = await getTemplateForUser(USER_A, 9_999_999);
  assert.equal(none, undefined);
});
