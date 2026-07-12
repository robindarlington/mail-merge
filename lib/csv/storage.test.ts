/**
 * Traversal-proof CSV storage tests (V12 / T-3-TRAV).
 *
 * Proves the security invariant structurally: `writeUpload` names the on-disk
 * file from `crypto.randomUUID()`, so a user-supplied filename can never become
 * a path component. The returned `storagePath` is the RELATIVE `<uuid>.csv`
 * (resolved against UPLOADS_DIR at read time — Pitfall 4).
 *
 * Pattern (mirrors lib/data/smtp.test.ts): set a throwaway `UPLOADS_PATH` BEFORE
 * dynamically importing ./storage, since it resolves the dir at module load;
 * clean the temp dir up in after().
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// --- Provision an isolated uploads dir BEFORE importing ./storage ------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "csv-storage-"));
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;

const { writeUpload } = await import("./storage");

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const UUID_CSV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/;

test("writeUpload returns a relative <uuid>.csv path", () => {
  const { storagePath } = writeUpload(Buffer.from("email\na@x.com\n", "utf8"));
  assert.match(storagePath, UUID_CSV_RE);
});

test("writeUpload creates UPLOADS_DIR if absent", () => {
  // The dir did not exist before the first writeUpload above.
  writeUpload(Buffer.from("email\nb@x.com\n", "utf8"));
  assert.ok(existsSync(UPLOADS_DIR), "uploads dir should be created");
});

test("the user filename never appears in the returned path (V12 / T-3-TRAV)", () => {
  const evil = "../../etc/passwd";
  const { storagePath } = writeUpload(Buffer.from("x", "utf8"));
  // The opaque path is a bare <uuid>.csv — no traversal, no user string.
  assert.match(storagePath, UUID_CSV_RE);
  assert.ok(!storagePath.includes(evil));
  assert.ok(!storagePath.includes(".."));
  assert.ok(!storagePath.includes("/"));
});

test("the written file round-trips to the original bytes", () => {
  const bytes = Buffer.from("email,name\na@x.com,Ada\n", "utf8");
  const { storagePath } = writeUpload(bytes);
  const onDisk = readFileSync(resolve(UPLOADS_DIR, storagePath));
  assert.deepEqual(onDisk, bytes);
});
