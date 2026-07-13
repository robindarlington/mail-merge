/**
 * Seam tests for the compose Server-Action core (04-03).
 *
 * These drive `previewCampaignCore` / `saveTemplateCore` directly with an
 * injected `userId` (the actions-core layer accepts it as a parameter, so tests
 * never need a live Next/Clerk runtime — mirrors lib/csv/actions-core.test.ts).
 *
 * Coverage:
 *  - cross-tenant `recipientSetId` → not_found (T-4-IDOR): the server resolves the
 *    CSV path from a userId-scoped row, never from the client.
 *  - owned set → all rows + columns + totalRows returned, with the SERVER-resolved
 *    emailColumn (persisted email_column) and a template-INDEPENDENT invalidEmailCount.
 *  - null email_column → emailColumn falls back to detectEmailColumn (same value used
 *    for invalidEmailCount).
 *  - a structurally malformed stored CSV → parse_error.
 *  - an invalid recipientSetId → validation.
 *  - saveTemplateCore happy path persists ONE template and returns its id; a blank
 *    subject → validation (write only after guards pass).
 *
 * Pattern (mirrors lib/csv/actions-core.test.ts): set temp DATABASE_PATH +
 * UPLOADS_PATH BEFORE any dynamic import that resolves those paths at module load,
 * then build the schema on the throwaway DB via committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision isolated temp DB + uploads dir BEFORE any path-resolving import -
const TMP_DIR = mkdtempSync(join(tmpdir(), "compose-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.UPLOADS_PATH = join(TMP_DIR, "uploads");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const { previewCampaignCore, saveTemplateCore } = await import("./actions-core");
const { createRecipientSet, listTemplatesForUser } = await import("@/lib/data");
const { writeUpload } = await import("@/lib/csv");
const { detectEmailColumn, parseCsv } = await import("@/lib/core");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

// One invalid email in the Email column (row 2) → invalidEmailCount === 1.
const CSV =
  "Email,Name\n" +
  "bob@example.com,Bob\n" +
  "not-an-email,Sue\n" +
  "amy@example.com,Amy";

/**
 * Seed a recipient set owned by `userId`: write the CSV bytes to the uploads dir,
 * then insert the userId-scoped row pointing at that storage path. Returns the
 * created row's id. `emailColumn` may be null to exercise the detect fallback.
 */
async function seedSet(
  userId: string,
  csv: string,
  emailColumn: string | null,
): Promise<number> {
  const { storagePath } = writeUpload(Buffer.from(csv));
  const { columns, rows } = parseCsv(Buffer.from(csv));
  const [row] = await createRecipientSet(userId, {
    filename: "contacts.csv",
    columns_json: JSON.stringify(columns),
    row_count: rows.length,
    storage_path: storagePath,
    email_column: emailColumn,
  });
  return row.id;
}

/** Build a FormData carrying a recipientSetId. */
function previewFd(recipientSetId: number | string): FormData {
  const form = new FormData();
  form.set("recipientSetId", String(recipientSetId));
  return form;
}

/** Build a FormData carrying subject + body. */
function saveFd(subject: string, body: string): FormData {
  const form = new FormData();
  form.set("subject", subject);
  form.set("body", body);
  return form;
}

before(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("previewCampaignCore returns not_found for a set owned by another tenant (IDOR)", async () => {
  const id = await seedSet(USER_A, CSV, "Email");
  const res = await previewCampaignCore(USER_B, previewFd(id));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "not_found");
});

test("previewCampaignCore returns ALL rows + columns + totalRows for an owned set", async () => {
  const id = await seedSet(USER_A, CSV, "Email");
  const res = await previewCampaignCore(USER_A, previewFd(id));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.columns, ["Email", "Name"]);
  assert.equal(res.data.totalRows, 3);
  // ALL rows returned so the client can compute template-dependent aggregates.
  assert.equal(res.data.rows.length, 3);
  assert.equal(res.data.rows[0].Email, "bob@example.com");
});

test("previewCampaignCore returns the persisted email_column + a matching invalidEmailCount", async () => {
  const id = await seedSet(USER_A, CSV, "Email");
  const res = await previewCampaignCore(USER_A, previewFd(id));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // The SERVER-resolved To: column is the persisted email_column verbatim.
  assert.equal(res.data.emailColumn, "Email");
  // Computed over ALL rows against that same column: one malformed email.
  assert.equal(res.data.invalidEmailCount, 1);
});

test("previewCampaignCore falls back to detectEmailColumn when email_column is null", async () => {
  const id = await seedSet(USER_A, CSV, null);
  const res = await previewCampaignCore(USER_A, previewFd(id));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const expected = detectEmailColumn(["Email", "Name"], res.data.rows);
  // emailColumn EQUALS detectEmailColumn(columns, rows) on a null-column row.
  assert.equal(res.data.emailColumn, expected);
  assert.equal(res.data.emailColumn, "Email");
  // invalidEmailCount is computed against the SAME resolved column.
  assert.equal(res.data.invalidEmailCount, 1);
});

test("previewCampaignCore never re-computes template aggregates (report is template-INDEPENDENT)", async () => {
  const id = await seedSet(USER_A, CSV, "Email");
  const res = await previewCampaignCore(USER_A, previewFd(id));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // The report deliberately OMITS unknownTokens / rowsWithEmptyValues — those are
  // template-dependent and computed client-side (Plan 05) from `rows`.
  assert.ok(!("unknownTokens" in res.data));
  assert.ok(!("rowsWithEmptyValues" in res.data));
});

test("previewCampaignCore returns parse_error on a structurally malformed stored CSV", async () => {
  // An unterminated quote is a real misparse (MissingQuotes/TooFewFields).
  const id = await seedSet(USER_A, 'Email,Name\n"bob@x.com,Bob', "Email");
  const res = await previewCampaignCore(USER_A, previewFd(id));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "parse_error");
});

test("previewCampaignCore returns validation for a non-numeric recipientSetId", async () => {
  const res = await previewCampaignCore(USER_A, previewFd("not-a-number"));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "validation");
});

test("saveTemplateCore persists ONE template for the injected userId and returns its id", async () => {
  const before = await listTemplatesForUser(USER_A);
  const res = await saveTemplateCore(
    USER_A,
    saveFd("Welcome {{Name}}", "Hi {{Name}}, your account is ready."),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(typeof res.data.id, "number");

  const after = await listTemplatesForUser(USER_A);
  assert.equal(after.length, before.length + 1);
  const saved = after.find((t) => t.id === res.data.id);
  assert.ok(saved, "the newly saved template is found");
  assert.equal(saved.subject, "Welcome {{Name}}");
  assert.equal(saved.body, "Hi {{Name}}, your account is ready.");
});

test("saveTemplateCore rejects a blank subject with a validation error (write only after guards)", async () => {
  const before = await listTemplatesForUser(USER_A);
  const res = await saveTemplateCore(USER_A, saveFd("   ", "A body."));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.kind, "validation");
  // No row was inserted on the failing path.
  const after = await listTemplatesForUser(USER_A);
  assert.equal(after.length, before.length);
});
