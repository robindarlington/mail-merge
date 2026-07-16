/**
 * Traversal-proof attachment storage tests (ATCH-03 / T-07-01 / T-07-02).
 *
 * Proves the security invariant structurally, mirroring lib/csv/storage.test.ts:
 * `writeAttachment` names the on-disk file from `crypto.randomUUID()` (+ a fixed
 * `.bin` extension), so a user-supplied filename can NEVER become a path
 * component. `resolveAttachmentPath` / `attachmentExists` resolve the stored
 * relative path against UPLOADS_DIR and prefix-check it, rejecting traversal.
 *
 * Pattern (mirrors lib/csv/storage.test.ts): set a throwaway `UPLOADS_PATH`
 * BEFORE dynamically importing ./storage, since it resolves the dir at module
 * load; clean the temp dir up in after().
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// --- Provision an isolated uploads dir BEFORE importing ./storage ------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "attach-storage-"));
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;

const { writeAttachment, resolveAttachmentPath, attachmentExists } = await import(
  "./storage"
);
const { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES, uploadAttachmentSchema } =
  await import("./schema");

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const UUID_BIN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

test("writeAttachment returns a relative <uuid>.bin path", () => {
  const { storagePath } = writeAttachment(Buffer.from("hello", "utf8"));
  assert.match(storagePath, UUID_BIN_RE);
});

test("writeAttachment creates UPLOADS_DIR if absent", () => {
  writeAttachment(Buffer.from("x", "utf8"));
  assert.ok(existsSync(UPLOADS_DIR), "uploads dir should be created");
});

test("the user filename never appears in the returned path (ATCH-03 / T-07-01)", () => {
  const evil = "../../etc/passwd.exe";
  const { storagePath } = writeAttachment(Buffer.from("x", "utf8"));
  assert.match(storagePath, UUID_BIN_RE);
  assert.ok(!storagePath.includes(evil));
  assert.ok(!storagePath.includes(".."));
  assert.ok(!storagePath.includes("/"));
});

test("the original extension is never trusted into the path", () => {
  // Even if a caller had a .sh/.php file, the on-disk name stays <uuid>.bin.
  const { storagePath } = writeAttachment(Buffer.from("#!/bin/sh", "utf8"));
  assert.ok(storagePath.endsWith(".bin"));
});

test("the written bytes round-trip via resolveAttachmentPath", () => {
  const bytes = Buffer.from("invoice-42 contents", "utf8");
  const { storagePath } = writeAttachment(bytes);
  const abs = resolveAttachmentPath(storagePath);
  assert.deepEqual(readFileSync(abs), bytes);
});

test("resolveAttachmentPath returns an ABSOLUTE path inside UPLOADS_DIR", () => {
  const { storagePath } = writeAttachment(Buffer.from("x", "utf8"));
  const abs = resolveAttachmentPath(storagePath);
  assert.equal(abs, resolve(UPLOADS_DIR, storagePath));
  assert.ok(abs.startsWith(UPLOADS_DIR));
});

test("attachmentExists is true for a written file, false for a never-written path", () => {
  const { storagePath } = writeAttachment(Buffer.from("x", "utf8"));
  assert.equal(attachmentExists(storagePath), true);
  assert.equal(
    attachmentExists("00000000-0000-0000-0000-000000000000.bin"),
    false,
  );
});

test("resolveAttachmentPath rejects a traversal path (T-07-02)", () => {
  assert.throws(
    () => resolveAttachmentPath("../../etc/passwd"),
    /resolved attachment path escaped the uploads directory/,
  );
});

test("attachmentExists rejects a traversal path (T-07-02)", () => {
  assert.throws(
    () => attachmentExists("../../etc/passwd"),
    /resolved attachment path escaped the uploads directory/,
  );
});

test("limit constants are exported with the decided defaults (T-07-03)", () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_MESSAGE_BYTES, 15 * 1024 * 1024);
});

test("uploadAttachmentSchema rejects a file over MAX_ATTACHMENT_BYTES", () => {
  const ok = uploadAttachmentSchema.safeParse({
    name: "photo.jpg",
    size: 5 * 1024 * 1024,
  });
  assert.equal(ok.success, true);
  const tooBig = uploadAttachmentSchema.safeParse({
    name: "huge.zip",
    size: MAX_ATTACHMENT_BYTES + 1,
  });
  assert.equal(tooBig.success, false);
});

test("uploadAttachmentSchema accepts any file type (no extension/mime gate, W13)", () => {
  for (const name of ["a.sh", "b.php", "c", "d.exe", "e.pdf"]) {
    const r = uploadAttachmentSchema.safeParse({ name, size: 1 });
    assert.equal(r.success, true, `${name} should be accepted`);
  }
});
