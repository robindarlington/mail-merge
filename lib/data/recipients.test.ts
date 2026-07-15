/**
 * Cross-tenant isolation tests for the recipient_sets DAL (CSV-05 / AUTH-02 / T-3-IDOR).
 *
 * These prove the tenancy invariant structurally: User A can never read User B's
 * recipient set, and every list/read is owner-scoped. `getRecipientSetForUser`
 * has no fetch-by-id-alone path, so an id owned by User A returns undefined when
 * queried as User B.
 *
 * Pattern (mirrors lib/data/smtp.test.ts): set a temp `DATABASE_PATH` BEFORE
 * dynamically importing anything that transitively opens the DB
 * (lib/db/client.ts resolves DATABASE_PATH at module load), then build the
 * schema on that throwaway file via the committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB BEFORE any DB import -----------------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "recipients-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");

// Dynamic imports so the env var above is in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const {
  createRecipientSet,
  listRecipientSetsForUser,
  getRecipientSetForUser,
  renameRecipientSet,
} = await import("./recipients");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

/** Build a persistable recipient-set values object (no userId — server-injected). */
function recipientValues(filename: string, columns: string[], rowCount: number) {
  return {
    filename,
    columns_json: JSON.stringify(columns),
    row_count: rowCount,
    storage_path: `${filename}.csv`,
  };
}

// Ids captured during seeding for the ownership/ordering assertions.
let A_FIRST_ID = 0;
let A_SECOND_ID = 0;
let B_ID = 0;

before(async () => {
  // Build all six tables (and indexes) on the temp DB from committed migrations.
  migrate(db, { migrationsFolder: "./drizzle" });

  const [aFirst] = await createRecipientSet(
    USER_A,
    recipientValues("a-first", ["email", "name"], 3),
  );
  const [aSecond] = await createRecipientSet(
    USER_A,
    recipientValues("a-second", ["email", "company"], 5),
  );
  const [b] = await createRecipientSet(
    USER_B,
    recipientValues("b-only", ["email"], 1),
  );

  A_FIRST_ID = aFirst.id;
  A_SECOND_ID = aSecond.id;
  B_ID = b.id;

  // created_at defaults to unixepoch() seconds; two inserts in the same second
  // tie, which would make newest-first ordering non-deterministic. Force
  // distinct timestamps so the desc(created_at) ordering assertion is stable.
  connection
    .prepare("UPDATE recipient_sets SET created_at = ? WHERE id = ?")
    .run(1000, A_FIRST_ID);
  connection
    .prepare("UPDATE recipient_sets SET created_at = ? WHERE id = ?")
    .run(2000, A_SECOND_ID);
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("createRecipientSet persists the server-supplied userId and returns the new row", async () => {
  const [row] = await createRecipientSet(
    USER_A,
    recipientValues("a-extra", ["email"], 2),
  );
  assert.ok(row.id, "returned row carries a generated id");
  assert.equal(row.userId, USER_A, "userId is the server-supplied caller id");
  assert.equal(row.filename, "a-extra");
  assert.equal(row.row_count, 2);
  assert.equal(row.storage_path, "a-extra.csv");
  assert.deepEqual(JSON.parse(row.columns_json), ["email"]);
});

test("listRecipientSetsForUser returns only the caller's sets, newest first", async () => {
  const aSets = await listRecipientSetsForUser(USER_A);
  // Every returned row belongs to USER_A — USER_B's set never appears.
  assert.ok(
    aSets.every((s) => s.userId === USER_A),
    "list is scoped to the caller",
  );
  assert.ok(
    !aSets.some((s) => s.id === B_ID),
    "User B's set is never in User A's list",
  );

  // Newest-first: a-second (created_at 2000) precedes a-first (created_at 1000).
  const firstIdx = aSets.findIndex((s) => s.id === A_FIRST_ID);
  const secondIdx = aSets.findIndex((s) => s.id === A_SECOND_ID);
  assert.ok(secondIdx !== -1 && firstIdx !== -1);
  assert.ok(secondIdx < firstIdx, "newest (a-second) sorts before older (a-first)");
});

test("listRecipientSetsForUser for User B never returns User A's sets", async () => {
  const bSets = await listRecipientSetsForUser(USER_B);
  assert.ok(bSets.every((s) => s.userId === USER_B));
  assert.ok(!bSets.some((s) => s.id === A_FIRST_ID || s.id === A_SECOND_ID));
});

test("getRecipientSetForUser returns the row for its owner", async () => {
  const row = await getRecipientSetForUser(USER_A, A_FIRST_ID);
  assert.ok(row, "owner can read their own set");
  assert.equal(row.id, A_FIRST_ID);
  assert.equal(row.userId, USER_A);
});

test("getRecipientSetForUser blocks cross-tenant reads (IDOR)", async () => {
  // User B supplies an id that belongs to User A — must get undefined, never A's row.
  const leaked = await getRecipientSetForUser(USER_B, A_FIRST_ID);
  assert.equal(leaked, undefined, "cross-tenant read returns undefined");
});

test("getRecipientSetForUser returns undefined for a non-existent id", async () => {
  const none = await getRecipientSetForUser(USER_A, 9_999_999);
  assert.equal(none, undefined);
});

test("renameRecipientSet updates the owner's row and the new label reads back", async () => {
  const [updated] = await renameRecipientSet(USER_A, A_FIRST_ID, "Q3 outreach");
  assert.ok(updated, "the owner's row is returned by the UPDATE");
  assert.equal(updated.id, A_FIRST_ID);
  assert.equal(updated.label, "Q3 outreach", "the new label is persisted");
  // The label reads back through the owner-scoped fetch, and filename is untouched.
  const reread = await getRecipientSetForUser(USER_A, A_FIRST_ID);
  assert.equal(reread?.label, "Q3 outreach");
  assert.equal(reread?.filename, "a-first", "the original filename is preserved");
});

test("renameRecipientSet by User B on User A's set updates zero rows (IDOR)", async () => {
  const before = await getRecipientSetForUser(USER_A, A_SECOND_ID);
  const changed = await renameRecipientSet(USER_B, A_SECOND_ID, "hijacked");
  assert.equal(changed.length, 0, "a cross-tenant rename updates zero rows");
  // User A's row is untouched — its label is exactly what it was before.
  const after = await getRecipientSetForUser(USER_A, A_SECOND_ID);
  assert.equal(after?.label, before?.label ?? null, "the owner's label is unchanged");
});
