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
const {
  createTemplate,
  listTemplatesForUser,
  getTemplateForUser,
  listTemplatesForRecipientSet,
  countCampaignsForTemplate,
  deleteTemplateForUser,
} = await import("./templates");
const { createRecipientSet } = await import("./recipients");
const { campaigns, smtp_configs } = await import("@/lib/db/schema");
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

// --- list-scoped library (tpl): recipient_set_id stamping + list read ---------
//
// Templates are scoped to a recipient list (one-to-many). A template's {{column}}
// merge fields only make sense against a specific list, so save-time stamps the
// list id and the library read filters on it. NULL-scoped legacy rows belong to no
// list and never surface (D1). All reads/deletes stay owner-scoped (AUTH-02).

/** Seed an owned recipient set and return its id (server-injected userId). */
async function seedSet(userId: string, filename: string): Promise<number> {
  const [set] = await createRecipientSet(userId, {
    filename,
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 1,
    storage_path: `${filename}.csv`,
  });
  return set.id;
}

/** Seed a campaign referencing `templateId` (wiring the other NOT-NULL FKs). */
async function seedCampaignForTemplate(userId: string, setId: number, templateId: number) {
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
      template_id: templateId,
      smtp_config_id: cfg.id,
      status: "completed",
    })
    .returning();
  return camp;
}

test("createTemplate stamps recipient_set_id when supplied (userId still server-injected)", async () => {
  const setId = await seedSet(USER_A, "stamp-set");
  const [row] = await createTemplate(USER_A, {
    subject: "Hi {{name}}",
    body: "Body.",
    recipient_set_id: setId,
  });
  assert.equal(row.userId, USER_A, "userId is server-injected, not spoofable");
  assert.equal(row.recipient_set_id, setId, "the supplied list id is stamped");
});

test("createTemplate leaves recipient_set_id null when omitted (backward-compatible)", async () => {
  const [row] = await createTemplate(USER_A, {
    subject: "Unscoped",
    body: "No list.",
  });
  assert.equal(row.recipient_set_id, null, "an omitted list id stays null (legacy shape)");
});

test("listTemplatesForRecipientSet returns only that list's templates, newest first", async () => {
  const setId = await seedSet(USER_A, "lib-set");
  const [older] = await createTemplate(USER_A, {
    subject: "Older",
    body: "b",
    recipient_set_id: setId,
  });
  const [newer] = await createTemplate(USER_A, {
    subject: "Newer",
    body: "b",
    recipient_set_id: setId,
  });
  // Distinct timestamps so desc(created_at) ordering is deterministic.
  connection.prepare("UPDATE templates SET created_at = ? WHERE id = ?").run(1000, older.id);
  connection.prepare("UPDATE templates SET created_at = ? WHERE id = ?").run(2000, newer.id);

  const lib = await listTemplatesForRecipientSet(USER_A, setId);
  assert.equal(lib.length, 2, "only the two templates scoped to this list");
  assert.ok(lib.every((t) => t.recipient_set_id === setId));
  assert.equal(lib[0].id, newer.id, "newest first");
  assert.equal(lib[1].id, older.id);
});

test("listTemplatesForRecipientSet excludes NULL-scoped legacy rows (D1)", async () => {
  const setId = await seedSet(USER_A, "d1-set");
  await createTemplate(USER_A, { subject: "Legacy", body: "b" }); // NULL scope
  const [scoped] = await createTemplate(USER_A, {
    subject: "Scoped",
    body: "b",
    recipient_set_id: setId,
  });
  const lib = await listTemplatesForRecipientSet(USER_A, setId);
  assert.deepEqual(
    lib.map((t) => t.id),
    [scoped.id],
    "a NULL-scoped row never appears in any list's library",
  );
});

test("listTemplatesForRecipientSet is empty for a cross-tenant caller (IDOR)", async () => {
  const setId = await seedSet(USER_A, "xtenant-set");
  await createTemplate(USER_A, { subject: "A's", body: "b", recipient_set_id: setId });
  const leaked = await listTemplatesForRecipientSet(USER_B, setId);
  assert.equal(leaked.length, 0, "User B never sees User A's list templates");
});

test("countCampaignsForTemplate counts the caller's referencing campaigns; cross-tenant is 0", async () => {
  const setId = await seedSet(USER_A, "count-set");
  const [tpl] = await createTemplate(USER_A, {
    subject: "Referenced",
    body: "b",
    recipient_set_id: setId,
  });
  assert.equal(await countCampaignsForTemplate(USER_A, tpl.id), 0, "no campaigns → 0");
  await seedCampaignForTemplate(USER_A, setId, tpl.id);
  assert.equal(await countCampaignsForTemplate(USER_A, tpl.id), 1, "one campaign → 1");
  assert.equal(await countCampaignsForTemplate(USER_B, tpl.id), 0, "cross-tenant → 0");
});

test("deleteTemplateForUser removes the owner's row and returns it", async () => {
  const setId = await seedSet(USER_A, "del-tpl-set");
  const [tpl] = await createTemplate(USER_A, {
    subject: "Delete me",
    body: "b",
    recipient_set_id: setId,
  });
  const removed = await deleteTemplateForUser(USER_A, tpl.id);
  assert.equal(removed.length, 1, "the owner's row is returned by the DELETE");
  assert.equal(removed[0].id, tpl.id);
  assert.equal(await getTemplateForUser(USER_A, tpl.id), undefined, "gone after delete");
});

test("deleteTemplateForUser by User B on User A's template removes zero rows (IDOR)", async () => {
  const setId = await seedSet(USER_A, "del-guard-set");
  const [tpl] = await createTemplate(USER_A, {
    subject: "Guarded",
    body: "b",
    recipient_set_id: setId,
  });
  const removed = await deleteTemplateForUser(USER_B, tpl.id);
  assert.equal(removed.length, 0, "a cross-tenant delete removes zero rows");
  assert.ok(await getTemplateForUser(USER_A, tpl.id), "the owner's template survives");
});
