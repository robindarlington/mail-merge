/**
 * Seam tests for the CSV Server-Action core (03-03).
 *
 * These drive `parseUploadedCsvCore` / `saveRecipientSetCore` directly with an
 * injected `userId` (the actions-core layer accepts it as a parameter, so tests
 * never need a live Next/Clerk runtime — mirrors lib/data/smtp.test.ts).
 *
 * Coverage:
 *  - userId injection + end-to-end parse → save persists ONE recipient_sets row.
 *  - mime/size/row-cap rejection at BOTH parse and save (row cap enforced at parse).
 *  - per-column `invalidCounts` (override path can surface a different count with
 *    no client re-parse).
 *  - confirmed-column override drives the persisted `invalidCount` (not auto-detect).
 *
 * Pattern (mirrors lib/data/smtp.test.ts): set temp DATABASE_PATH + UPLOADS_PATH
 * BEFORE any dynamic import that resolves those paths at module load, then build
 * the schema on the throwaway DB via committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// --- Provision isolated temp DB + uploads dir BEFORE any path-resolving import -
const TMP_DIR = mkdtempSync(join(tmpdir(), "csv-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.UPLOADS_PATH = join(TMP_DIR, "uploads");
const UPLOADS_DIR = join(TMP_DIR, "uploads");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { parseUploadedCsvCore, saveRecipientSetCore, deleteRecipientSetCore } =
  await import("./actions-core");
const { listRecipientSetsForUser, getRecipientSetForUser } = await import(
  "@/lib/data"
);
const { campaigns, templates, smtp_configs } = await import("@/lib/db/schema");
const { MAX_ROWS } = await import("./schema");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

/** Build a FormData carrying a CSV File (+ optional confirmed emailColumn). */
function fd(
  csv: string,
  opts: { filename?: string; type?: string; emailColumn?: string } = {},
) {
  const form = new FormData();
  form.set(
    "file",
    new File([csv], opts.filename ?? "list.csv", {
      type: opts.type ?? "text/csv",
    }),
  );
  if (opts.emailColumn !== undefined) form.set("emailColumn", opts.emailColumn);
  return form;
}

const GOOD_CSV =
  "Email,Name\n" +
  "bob@example.com,Bob\n" +
  "sue@example.com,Sue\n" +
  "amy@example.com,Amy";

before(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("parseUploadedCsvCore detects the email column and summarizes a clean CSV", async () => {
  const res = await parseUploadedCsvCore(USER_A, fd(GOOD_CSV));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.detectedEmailColumn, "Email");
  assert.equal(res.data.rowCount, 3);
  assert.equal(res.data.invalidCount, 0);
  // one entry PER column, so the UI can surface any override without re-parsing.
  assert.deepEqual(Object.keys(res.data.invalidCounts).sort(), [
    "Email",
    "Name",
  ]);
});

test("parseUploadedCsvCore exposes a per-column invalidCounts map (override path)", async () => {
  const res = await parseUploadedCsvCore(USER_A, fd(GOOD_CSV));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // Names are never valid emails, so the non-email column's invalid count is
  // strictly higher than the (all-valid) email column's — proving the override
  // path can display the right count client-side with no papaparse re-parse.
  assert.equal(res.data.invalidCounts.Email, 0);
  assert.equal(res.data.invalidCounts.Name, 3);
  assert.ok(res.data.invalidCounts.Name > res.data.invalidCounts.Email);
});

test("parseUploadedCsvCore rejects a wrong file type", async () => {
  const res = await parseUploadedCsvCore(
    USER_A,
    fd(GOOD_CSV, { filename: "list.txt", type: "text/plain" }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "wrong_type");
});

test("parseUploadedCsvCore rejects a missing/non-File field", async () => {
  const form = new FormData();
  form.set("file", "not-a-file");
  const res = await parseUploadedCsvCore(USER_A, form);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "wrong_type");
});

test("parseUploadedCsvCore returns 'empty' for a headerless/empty CSV", async () => {
  const res = await parseUploadedCsvCore(USER_A, fd(""));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "empty");
});

test("parseUploadedCsvCore returns 'parse_error' on a structural misparse", async () => {
  // An unterminated quote is a real misparse (MissingQuotes/TooFewFields).
  const res = await parseUploadedCsvCore(
    USER_A,
    fd('Email,Name\n"bob@x.com,Bob'),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "parse_error");
});

test("parseUploadedCsvCore accepts a legitimate single-column CSV", async () => {
  // A single-column CSV emits papaparse's benign UndetectableDelimiter warning;
  // it must NOT be treated as a structural parse_error.
  const res = await parseUploadedCsvCore(
    USER_A,
    fd("Email\na@example.com\nb@example.com"),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.detectedEmailColumn, "Email");
  assert.equal(res.data.rowCount, 2);
});

test("parseUploadedCsvCore rejects a CSV over MAX_ROWS at parse time", async () => {
  const rows = Array.from(
    { length: MAX_ROWS + 1 },
    (_, i) => `person${i}@example.com,Person ${i}`,
  ).join("\n");
  const res = await parseUploadedCsvCore(USER_A, fd(`Email,Name\n${rows}`));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "too_many_rows");
});

test("saveRecipientSetCore persists ONE row for the injected userId (end-to-end)", async () => {
  const before = await listRecipientSetsForUser(USER_A);
  const res = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { filename: "contacts.csv", emailColumn: "Email" }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.rowCount, 3);
  assert.equal(res.data.filename, "contacts.csv");
  assert.equal(res.data.invalidCount, 0);

  const after = await listRecipientSetsForUser(USER_A);
  assert.equal(after.length, before.length + 1);
  const saved = after[0];
  assert.equal(saved.filename, "contacts.csv");
  assert.equal(saved.row_count, 3);
  // columns_json round-trips back to the header array.
  assert.deepEqual(JSON.parse(saved.columns_json), ["Email", "Name"]);
  // the confirmed email column is persisted on the row (CR-01).
  assert.equal(saved.email_column, "Email");
  // a file was actually written under the uploads dir.
  assert.ok(readdirSync(join(TMP_DIR, "uploads")).length >= 1);
});

test("saveRecipientSetCore counts invalid on the CONFIRMED column (override honored)", async () => {
  // Auto-detect would pick "Email"; the user confirms "Contact" instead. The
  // Contact column has one blank + one malformed value → invalidCount 2.
  const csv =
    "Email,Contact\n" +
    "a@example.com,x@example.com\n" +
    "b@example.com,\n" +
    "c@example.com,not-an-email";

  // parse step establishes the per-column counts the UI would show for Contact.
  const parsed = await parseUploadedCsvCore(USER_A, fd(csv));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.detectedEmailColumn, "Email");
  assert.equal(parsed.data.invalidCounts.Contact, 2);

  // Capture existing ids so we can pinpoint the row THIS save inserts (created_at
  // ties within one unixepoch second make newest-first ordering non-deterministic).
  const beforeIds = new Set(
    (await listRecipientSetsForUser(USER_A)).map((s) => s.id),
  );

  const res = await saveRecipientSetCore(
    USER_A,
    fd(csv, { emailColumn: "Contact" }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // The CONFIRMED column drives the persisted count, matching the parse step.
  assert.equal(res.data.invalidCount, 2);
  assert.equal(res.data.invalidCount, parsed.data.invalidCounts.Contact);
  assert.notEqual(res.data.invalidCount, parsed.data.invalidCounts.Email);

  // The persisted row records the OVERRIDDEN column ("Contact"), not the
  // auto-detected one ("Email") — the override survives to the DB (CR-01).
  const saved = (await listRecipientSetsForUser(USER_A)).find(
    (s) => !beforeIds.has(s.id),
  );
  assert.ok(saved, "the newly saved recipient set is found");
  assert.equal(saved.email_column, "Contact");
  assert.notEqual(saved.email_column, parsed.data.detectedEmailColumn);
});

test("saveRecipientSetCore rejects an invalid confirmed emailColumn", async () => {
  // Blank confirmed column → schema validation failure.
  const blank = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { emailColumn: "" }),
  );
  assert.equal(blank.ok, false);
  if (blank.ok) return;
  assert.equal(blank.error.kind, "validation");

  // A column that is not in the header set → validation failure.
  const notAColumn = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { emailColumn: "Nope" }),
  );
  assert.equal(notAColumn.ok, false);
  if (notAColumn.ok) return;
  assert.equal(notAColumn.error.kind, "validation");
});

test("saveRecipientSetCore rejects a too-large row count and persists NOTHING", async () => {
  const before = await listRecipientSetsForUser(USER_A);
  const filesBefore = readdirSync(join(TMP_DIR, "uploads")).length;

  const rows = Array.from(
    { length: MAX_ROWS + 1 },
    (_, i) => `person${i}@example.com,Person ${i}`,
  ).join("\n");
  const res = await saveRecipientSetCore(
    USER_A,
    fd(`Email,Name\n${rows}`, { emailColumn: "Email" }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "too_many_rows");

  // Orphan avoidance: no row inserted AND no file written.
  const after = await listRecipientSetsForUser(USER_A);
  assert.equal(after.length, before.length);
  assert.equal(readdirSync(join(TMP_DIR, "uploads")).length, filesBefore);
});

// --- deleteRecipientSetCore (mdt): in-use guard, owner scope, CSV unlink ------
//
// A list referenced by ANY campaign is blocked (in_use) and nothing is removed;
// otherwise the row is deleted owner-scoped and its stored CSV is unlinked. A
// cross-tenant / unknown id removes nothing → not_found (T-mdt-01 / IDOR).

/** Insert a campaign referencing `setId`, wiring the two other NOT-NULL FKs
 *  directly (a throwaway template + smtp_config) — no crypto key needed. */
async function seedCampaign(userId: string, setId: number) {
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
  await db
    .insert(campaigns)
    .values({
      userId,
      recipient_set_id: setId,
      template_id: tpl.id,
      smtp_config_id: cfg.id,
    })
    .returning();
}

test("deleteRecipientSetCore removes an unreferenced list and unlinks its CSV (happy path)", async () => {
  // Save a real list so a file lands on disk under UPLOADS_DIR.
  const saved = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { filename: "to-delete.csv", emailColumn: "Email" }),
  );
  assert.equal(saved.ok, true);
  const set = (await listRecipientSetsForUser(USER_A)).find(
    (s) => s.filename === "to-delete.csv",
  );
  assert.ok(set, "the saved set exists");
  const fileOnDisk = resolve(UPLOADS_DIR, set.storage_path);
  assert.ok(existsSync(fileOnDisk), "the CSV file exists before delete");

  const res = await deleteRecipientSetCore(USER_A, set.id);
  assert.equal(res.ok, true, "an unreferenced list is deletable");

  // The row is gone AND the CSV file was unlinked.
  assert.equal(
    await getRecipientSetForUser(USER_A, set.id),
    undefined,
    "the recipient_set row is removed",
  );
  assert.ok(!existsSync(fileOnDisk), "the stored CSV file is unlinked");
});

test("deleteRecipientSetCore BLOCKS a list referenced by a campaign (in_use) and removes nothing", async () => {
  const saved = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { filename: "referenced.csv", emailColumn: "Email" }),
  );
  assert.equal(saved.ok, true);
  const set = (await listRecipientSetsForUser(USER_A)).find(
    (s) => s.filename === "referenced.csv",
  );
  assert.ok(set);
  const fileOnDisk = resolve(UPLOADS_DIR, set.storage_path);
  await seedCampaign(USER_A, set.id);

  const res = await deleteRecipientSetCore(USER_A, set.id);
  assert.equal(res.ok, false, "a referenced list is refused");
  assert.ok(!res.ok && res.error.kind === "in_use");

  // Nothing removed: the row AND the CSV file survive the blocked delete.
  const still = await getRecipientSetForUser(USER_A, set.id);
  assert.ok(still, "the referenced list survives");
  assert.ok(existsSync(fileOnDisk), "the CSV file survives a blocked delete");
});

test("deleteRecipientSetCore returns not_found for a cross-tenant id and removes nothing (IDOR)", async () => {
  const saved = await saveRecipientSetCore(
    USER_A,
    fd(GOOD_CSV, { filename: "owned.csv", emailColumn: "Email" }),
  );
  assert.equal(saved.ok, true);
  const set = (await listRecipientSetsForUser(USER_A)).find(
    (s) => s.filename === "owned.csv",
  );
  assert.ok(set);
  const fileOnDisk = resolve(UPLOADS_DIR, set.storage_path);

  const res = await deleteRecipientSetCore(USER_B, set.id);
  assert.equal(res.ok, false, "a cross-tenant delete is refused");
  assert.ok(!res.ok && res.error.kind === "not_found");

  // The owner's row + file are untouched.
  const still = await getRecipientSetForUser(USER_A, set.id);
  assert.ok(still, "the owner's list survives a cross-tenant delete");
  assert.ok(existsSync(fileOnDisk), "the owner's CSV file survives");
});

test("deleteRecipientSetCore rejects a non-numeric id as validation", async () => {
  const res = await deleteRecipientSetCore(USER_A, "not-a-number");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.kind === "validation");
});
