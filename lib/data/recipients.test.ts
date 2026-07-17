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
const { eq } = await import("drizzle-orm");
const { db, connection } = await import("@/lib/db");
const { campaigns, templates, smtp_configs } = await import("@/lib/db/schema");
const {
  createRecipientSet,
  listRecipientSetsForUser,
  getRecipientSetForUser,
  renameRecipientSet,
  countCampaignsForRecipientSet,
  deleteRecipientSetForUser,
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

// --- countCampaignsForRecipientSet + deleteRecipientSetForUser (mdt) ----------
//
// A list referenced by ANY campaign (any status) must NOT be deletable — the
// recipient_set_id FK is NOT NULL with no cascade, so a raw delete would violate
// the FK. The count spans ALL statuses (distinct from the queued/running-only
// active count). The DELETE is owner-scoped: a cross-tenant id removes zero rows.

/** Seed a campaign in a given status referencing `setId`, wiring the two other
 *  NOT-NULL FKs directly (a throwaway template + smtp_config for the owner). */
async function seedCampaign(userId: string, setId: number, status: string) {
  const [tpl] = await db
    .insert(templates)
    .values({ userId, subject: "S", body: "B" })
    .returning();
  const [cfg] = await db
    .insert(smtp_configs)
    .values({
      userId,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "u",
      password_enc: Buffer.from("enc"),
      password_iv: Buffer.from("iv"),
      password_tag: Buffer.from("tag"),
      from_addr: "noreply@example.com",
    })
    .returning();
  const [camp] = await db
    .insert(campaigns)
    .values({
      userId,
      recipient_set_id: setId,
      template_id: tpl.id,
      smtp_config_id: cfg.id,
      status,
    })
    .returning();
  return camp;
}

test("countCampaignsForRecipientSet is 0 for an unreferenced set and for a cross-tenant set", async () => {
  const [set] = await createRecipientSet(USER_A, recipientValues("count-none", ["email"], 1));
  assert.equal(await countCampaignsForRecipientSet(USER_A, set.id), 0, "no campaigns → 0");
  // Even once a campaign references it, USER_B (who does not own it) counts 0.
  await seedCampaign(USER_A, set.id, "draft");
  assert.equal(await countCampaignsForRecipientSet(USER_B, set.id), 0, "cross-tenant → 0");
});

test("countCampaignsForRecipientSet counts campaigns across ALL statuses", async () => {
  const [set] = await createRecipientSet(USER_A, recipientValues("count-all", ["email"], 1));
  await seedCampaign(USER_A, set.id, "draft");
  await seedCampaign(USER_A, set.id, "completed");
  await seedCampaign(USER_A, set.id, "failed");
  assert.equal(
    await countCampaignsForRecipientSet(USER_A, set.id),
    3,
    "draft + completed + failed all count toward the delete-guard",
  );
});

test("deleteRecipientSetForUser removes the owner's row and returns it", async () => {
  const [set] = await createRecipientSet(USER_A, recipientValues("del-me", ["email"], 2));
  const removed = await deleteRecipientSetForUser(USER_A, set.id);
  assert.equal(removed.length, 1, "the owner's row is returned by the DELETE");
  assert.equal(removed[0].id, set.id);
  assert.equal(
    await getRecipientSetForUser(USER_A, set.id),
    undefined,
    "the set is gone after delete",
  );
});

test("deleteRecipientSetForUser by User B on User A's set removes zero rows (IDOR)", async () => {
  const [set] = await createRecipientSet(USER_A, recipientValues("del-guarded", ["email"], 1));
  const removed = await deleteRecipientSetForUser(USER_B, set.id);
  assert.equal(removed.length, 0, "a cross-tenant delete removes zero rows");
  const still = await getRecipientSetForUser(USER_A, set.id);
  assert.ok(still, "the owner's set survives a cross-tenant delete");
});

// --- list delete cascades its templates transactionally (tpl / D3) ------------
//
// Deleting a list removes its list-scoped templates in the SAME transaction. A
// template scoped to the list but referenced by a campaign throws an FK violation
// that rolls the WHOLE transaction back — the set and its templates all survive —
// so the delete core can map it to in_use. Draft (unreferenced) templates cascade.

test("deleteRecipientSetForUser cascades the list's draft templates in one transaction", async () => {
  const [set] = await createRecipientSet(USER_A, recipientValues("cascade-set", ["email"], 1));
  const [t1] = await db
    .insert(templates)
    .values({ userId: USER_A, subject: "S1", body: "B1", recipient_set_id: set.id })
    .returning();
  const [t2] = await db
    .insert(templates)
    .values({ userId: USER_A, subject: "S2", body: "B2", recipient_set_id: set.id })
    .returning();

  const removed = await deleteRecipientSetForUser(USER_A, set.id);
  assert.equal(removed.length, 1, "the set row is returned by the DELETE");
  assert.equal(await getRecipientSetForUser(USER_A, set.id), undefined, "set is gone");

  // Both list-scoped templates were removed in the same transaction.
  const survivorIds = (await db.query.templates.findMany()).map((t) => t.id);
  assert.ok(!survivorIds.includes(t1.id), "list template 1 cascaded away");
  assert.ok(!survivorIds.includes(t2.id), "list template 2 cascaded away");
});

test("deleteRecipientSetForUser rolls back when a list-scoped template is campaign-referenced (D3)", async () => {
  // The list to delete, and a SECOND list that owns the referencing campaign.
  const [victim] = await createRecipientSet(USER_A, recipientValues("victim-set", ["email"], 1));
  const [other] = await createRecipientSet(USER_A, recipientValues("other-set", ["email"], 1));
  // A template scoped to the victim list...
  const [tpl] = await db
    .insert(templates)
    .values({ userId: USER_A, subject: "Ref", body: "B", recipient_set_id: victim.id })
    .returning();
  // ...referenced by a campaign whose own recipient_set is the OTHER list.
  const [cfg] = await db
    .insert(smtp_configs)
    .values({
      userId: USER_A,
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "u",
      password_enc: Buffer.from("enc"),
      password_iv: Buffer.from("iv"),
      password_tag: Buffer.from("tag"),
      from_addr: "noreply@example.com",
    })
    .returning();
  await db
    .insert(campaigns)
    .values({
      userId: USER_A,
      recipient_set_id: other.id,
      template_id: tpl.id,
      smtp_config_id: cfg.id,
      status: "completed",
    })
    .returning();

  // Deleting the victim list tries to delete its templates first → FK throw on the
  // referenced template → the whole transaction rolls back.
  await assert.rejects(
    async () => deleteRecipientSetForUser(USER_A, victim.id),
    "an FK-referenced list template makes the whole delete throw",
  );
  // Nothing was removed: both the set and the template survive.
  assert.ok(await getRecipientSetForUser(USER_A, victim.id), "the set survives the rollback");
  const stillThere = await db.query.templates.findFirst({
    where: eq(templates.id, tpl.id),
  });
  assert.ok(stillThere, "the referenced template survives the rollback");
});
