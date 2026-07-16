/**
 * Tests for the attachment action seams (ATCH-01 / T-07-04 / T-07-06).
 *
 * Proves the orchestration contract of the userId-accepting cores:
 *  - a happy upload writes ONE opaque file + inserts the DAL row and returns the
 *    refreshed pending list;
 *  - an oversized file → too_large, a non-File → wrong_type, a duplicate original
 *    filename (case-insensitive) → duplicate_filename;
 *  - a REJECTED upload leaves NO orphaned file on disk (guards-pass-THEN-write);
 *  - confirmAttachmentColumnCore persists the column for the owner and 0-rows/
 *    not_found for a cross-tenant set.
 *
 * Pattern: set a temp DATABASE_PATH + UPLOADS_PATH + CREDENTIAL_ENC_KEY BEFORE any
 * import that transitively opens the DB or resolves the uploads dir, then build the
 * schema on the throwaway DB via committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision isolated temp DB + uploads dir + key BEFORE any import ---------
const TMP_DIR = mkdtempSync(join(tmpdir(), "attach-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const { db, connection } = await import("@/lib/db");
const {
  uploadAttachmentCore,
  listAttachmentsCore,
  deleteAttachmentCore,
  confirmAttachmentColumnCore,
  matchAttachmentsCore,
} = await import("./actions-core");
const { MAX_ATTACHMENT_BYTES } = await import("./schema");
const { createRecipientSet, getRecipientSetForUser } = await import(
  "@/lib/data/recipients"
);
const { writeUpload } = await import("@/lib/csv");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

let A_SET_ID = 0;

/** Build a FormData carrying a File under the "file" field. */
function fileForm(name: string, bytes: Buffer): FormData {
  const fd = new FormData();
  fd.set("file", new File([bytes], name));
  return fd;
}

/** Count files currently in the uploads dir (0 if it doesn't exist yet). */
function uploadsCount(): number {
  try {
    return readdirSync(UPLOADS_DIR).length;
  } catch {
    return 0;
  }
}

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });
  const [set] = await createRecipientSet(USER_A, {
    filename: "a.csv",
    columns_json: JSON.stringify(["email", "file"]),
    row_count: 2,
    storage_path: "a.csv",
    email_column: "email",
  });
  A_SET_ID = set.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("uploadAttachmentCore writes a file + row and returns the pending list", async () => {
  const before = uploadsCount();
  const res = await uploadAttachmentCore(USER_A, fileForm("doc.pdf", Buffer.from("hello")));
  assert.ok(res.ok, "happy upload succeeds");
  if (!res.ok) return;
  assert.equal(uploadsCount(), before + 1, "exactly one file written");
  assert.ok(
    res.data.some((a) => a.filename === "doc.pdf"),
    "the new upload appears in the returned pending list",
  );
});

test("uploadAttachmentCore rejects an oversized file with too_large and writes nothing", async () => {
  const before = uploadsCount();
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0);
  const res = await uploadAttachmentCore(USER_A, fileForm("big.bin", big));
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.error.kind, "too_large");
  assert.equal(uploadsCount(), before, "no orphaned file after a rejected upload");
});

test("uploadAttachmentCore rejects a non-File with wrong_type", async () => {
  const fd = new FormData();
  fd.set("file", "not-a-file");
  const res = await uploadAttachmentCore(USER_A, fd);
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.error.kind, "wrong_type");
});

test("uploadAttachmentCore rejects a duplicate original filename (case-insensitive)", async () => {
  await uploadAttachmentCore(USER_A, fileForm("Report.pdf", Buffer.from("a")));
  const before = uploadsCount();
  const res = await uploadAttachmentCore(USER_A, fileForm("  report.PDF  ", Buffer.from("b")));
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.error.kind, "duplicate_filename");
  assert.equal(uploadsCount(), before, "the duplicate does not write a file");
});

test("deleteAttachmentCore removes the row + returns the updated list; cross-tenant is a benign no-op", async () => {
  const up = await uploadAttachmentCore(USER_A, fileForm("todelete.pdf", Buffer.from("x")));
  assert.ok(up.ok);
  if (!up.ok) return;
  const target = up.data.find((a) => a.filename === "todelete.pdf");
  assert.ok(target);
  if (!target) return;

  // A cross-tenant delete removes nothing.
  const bTry = await deleteAttachmentCore(USER_B, target.id);
  assert.ok(bTry.ok);
  const stillThere = await listAttachmentsCore(USER_A);
  assert.ok(stillThere.ok && stillThere.data.some((a) => a.id === target.id));

  // The owner removes it.
  const res = await deleteAttachmentCore(USER_A, target.id);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.ok(!res.data.some((a) => a.id === target.id), "the deleted row is gone from the list");
});

test("confirmAttachmentColumnCore persists the column for the owner", async () => {
  const res = await confirmAttachmentColumnCore(USER_A, A_SET_ID, "file");
  assert.ok(res.ok, "owner can confirm their column");
  const reread = await getRecipientSetForUser(USER_A, A_SET_ID);
  assert.equal(reread?.attachment_column, "file");
});

test("confirmAttachmentColumnCore cross-tenant returns not_found and persists nothing", async () => {
  const res = await confirmAttachmentColumnCore(USER_B, A_SET_ID, "hijacked");
  assert.ok(!res.ok);
  if (res.ok) return;
  assert.equal(res.error.kind, "not_found");
  const reread = await getRecipientSetForUser(USER_A, A_SET_ID);
  assert.notEqual(reread?.attachment_column, "hijacked");
});

test("matchAttachmentsCore re-reads the set's CSV and matches against pending uploads (no campaign)", async () => {
  // A recipient set whose CSV lives on disk and designates an attachment column.
  const csv = "email,file\na@x.com,invoice.pdf\nb@x.com,\n";
  const { storagePath } = writeUpload(Buffer.from(csv, "utf8"));
  const [set] = await createRecipientSet(USER_A, {
    filename: "match.csv",
    columns_json: JSON.stringify(["email", "file"]),
    row_count: 2,
    storage_path: storagePath,
    email_column: "email",
    attachment_column: "file",
  });
  // A pending upload that matches row 1's cell.
  await uploadAttachmentCore(USER_A, fileForm("invoice.pdf", Buffer.from("bytes")));

  const res = await matchAttachmentsCore(USER_A, set.id);
  assert.ok(res.ok, "the compose-time match resolves against pending uploads");
  if (!res.ok) return;
  assert.equal(res.data.attachmentColumn, "file");
  assert.equal(res.data.rowsWithAttachment, 1, "one row references a pending upload");
  assert.equal(res.data.attachmentTotal, 1, "the matched file is present on disk");
  assert.equal(res.data.missingAttachmentCount, 0, "the empty second row is not a miss");
});

test("matchAttachmentsCore cross-tenant/bogus id resolves to not_found", async () => {
  const bogus = await matchAttachmentsCore(USER_A, 9_999_999);
  assert.ok(!bogus.ok);
  if (bogus.ok) return;
  assert.equal(bogus.error.kind, "not_found");

  const crossTenant = await matchAttachmentsCore(USER_B, A_SET_ID);
  assert.ok(!crossTenant.ok);
  if (crossTenant.ok) return;
  assert.equal(crossTenant.error.kind, "not_found");
});
