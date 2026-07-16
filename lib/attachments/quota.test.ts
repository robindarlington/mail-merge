/**
 * Per-user upload quota tests (WR-02).
 *
 * `uploadAttachmentCore` must refuse an upload BEFORE writing any bytes once the
 * caller is at their pending/draft count cap OR the upload would push their total
 * pending bytes over the byte cap — returning a typed `quota_exceeded` error so one
 * tenant cannot loop uploads and exhaust the shared UPLOADS_PATH volume.
 *
 * The caps are read from env at module-eval time, so this file sets DELIBERATELY
 * LOW caps BEFORE any import, then drives both branches on two separate tenants
 * (the quota pool is per-user): USER_A hits the byte cap, USER_B hits the count cap.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision isolated temp DB + uploads dir + LOW quota caps BEFORE import ---
const TMP_DIR = mkdtempSync(join(tmpdir(), "attach-quota-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");
// Low caps: 2 pending uploads max, 30 total bytes max.
process.env.MAX_PENDING_ATTACHMENTS = "2";
process.env.MAX_PENDING_ATTACHMENT_BYTES = "30";

const { db, connection } = await import("@/lib/db");
const { uploadAttachmentCore } = await import("./actions-core");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_quota_aaaaaaaaaaaaaaaa";
const USER_B = "user_quota_bbbbbbbbbbbbbbbb";

function fileForm(name: string, bytes: Buffer): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], name));
  return fd;
}

function uploadsCount(): number {
  try {
    return readdirSync(UPLOADS_DIR).length;
  } catch {
    return 0;
  }
}

before(() => {
  migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("upload is refused once it would push total pending bytes over the cap (WR-02 byte cap)", async () => {
  // 25 bytes fits (count 1 < 2, bytes 25 < 30).
  const first = await uploadAttachmentCore(USER_A, fileForm("a.pdf", Buffer.alloc(25, 1)));
  assert.ok(first.ok, "the first upload fits under the byte cap");

  const before = uploadsCount();
  // +10 bytes → 35 > 30: refused on bytes even though count (1) is under the cap.
  const second = await uploadAttachmentCore(USER_A, fileForm("b.pdf", Buffer.alloc(10, 1)));
  assert.ok(!second.ok);
  if (second.ok) return;
  assert.equal(second.error.kind, "quota_exceeded", "the byte cap returns quota_exceeded");
  assert.equal(uploadsCount(), before, "the refused upload writes NO file (checked before disk write)");
});

test("upload is refused once the pending COUNT cap is reached (WR-02 count cap)", async () => {
  // Two tiny files fit (count 2 == cap after these, bytes 2 < 30).
  const one = await uploadAttachmentCore(USER_B, fileForm("one.pdf", Buffer.alloc(1, 1)));
  assert.ok(one.ok);
  const two = await uploadAttachmentCore(USER_B, fileForm("two.pdf", Buffer.alloc(1, 1)));
  assert.ok(two.ok);

  const before = uploadsCount();
  // Third upload: count (2) >= cap (2) → refused, even though bytes are tiny.
  const three = await uploadAttachmentCore(USER_B, fileForm("three.pdf", Buffer.alloc(1, 1)));
  assert.ok(!three.ok);
  if (three.ok) return;
  assert.equal(three.error.kind, "quota_exceeded", "the count cap returns quota_exceeded");
  assert.equal(uploadsCount(), before, "the refused upload writes NO file");
});
