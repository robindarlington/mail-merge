/**
 * Tests for the shared attachment matcher (ATCH-01 / ATCH-02).
 *
 * `computeAttachmentMatch` is the SINGLE matcher both the compose card and the
 * confirm gate run, so these assertions pin the counting contract exactly:
 *  - all rows matched → rowsWithAttachment/attachmentTotal, empty cell is NOT a miss;
 *  - a referenced file never uploaded → missingCount + a deduped capped sample;
 *  - a shared filename referenced by many rows counts EACH row;
 *  - a row whose attachment exceeds MAX_MESSAGE_BYTES → oversizeRowCount;
 *  - a null attachment column → the zero/empty case.
 *
 * Presence is resolved via attachmentExists against a real UPLOADS_PATH temp dir,
 * so the on-disk (attachmentTotal) vs DB-present-but-off-disk (miss) split is
 * exercised for real. Set UPLOADS_PATH BEFORE importing ./storage (via ./match).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated uploads dir BEFORE importing ./match --------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "attach-match-"));
process.env.UPLOADS_PATH = join(TMP_DIR, "uploads");

const { computeAttachmentMatch } = await import("./match");
const { writeAttachment } = await import("./storage");
const { MAX_MESSAGE_BYTES } = await import("./schema");

after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Write real bytes for a filename and return a MatchableAttachment row. */
function onDisk(filename: string, size = 10) {
  const { storagePath } = writeAttachment(Buffer.alloc(size, 1));
  return { filename, storage_path: storagePath, size_bytes: size };
}

const COLUMNS = ["email", "file"];

test("all rows matched and present: rowsWithAttachment + attachmentTotal, empty cell is not a miss", () => {
  const rows = [
    { email: "a@x.com", file: "one.pdf" },
    { email: "b@x.com", file: "two.pdf" },
    { email: "c@x.com", file: "" }, // empty — send without attachment, NOT a miss
  ];
  const attachments = [onDisk("one.pdf"), onDisk("two.pdf")];
  const m = computeAttachmentMatch(COLUMNS, rows, "file", attachments);

  assert.equal(m.rowsWithAttachment, 2, "two rows reference an uploaded file");
  assert.equal(m.attachmentTotal, 2, "both matched files are present on disk");
  assert.equal(m.missingAttachmentCount, 0, "the empty cell is not a miss");
  assert.deepEqual(m.missingAttachmentFilenames, []);
  assert.equal(m.oversizeRowCount, 0);
  assert.equal(m.sampleAttachment, "one.pdf", "sample is the first row's matched file");
});

test("a referenced file that was never uploaded is a miss (count + deduped capped sample)", () => {
  const rows = [
    { email: "a@x.com", file: "present.pdf" },
    { email: "b@x.com", file: "ghost.pdf" },
    { email: "c@x.com", file: "ghost.pdf" }, // same missing file — deduped in the sample
    { email: "d@x.com", file: "other-ghost.pdf" },
  ];
  const attachments = [onDisk("present.pdf")];
  const m = computeAttachmentMatch(COLUMNS, rows, "file", attachments);

  assert.equal(m.rowsWithAttachment, 1, "only the present file matched the DB set");
  assert.equal(m.attachmentTotal, 1);
  assert.equal(m.missingAttachmentCount, 3, "three rows reference a missing file");
  assert.deepEqual(
    m.missingAttachmentFilenames,
    ["ghost.pdf", "other-ghost.pdf"],
    "the sample is deduped",
  );
});

test("missing sample is capped at 5 distinct filenames while the count keeps climbing", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    email: `u${i}@x.com`,
    file: `missing-${i}.pdf`,
  }));
  const m = computeAttachmentMatch(COLUMNS, rows, "file", []);
  assert.equal(m.missingAttachmentCount, 8);
  assert.equal(m.missingAttachmentFilenames.length, 5, "sample capped at 5");
});

test("a shared filename referenced by many rows counts EACH row", () => {
  const rows = [
    { email: "a@x.com", file: "shared.pdf" },
    { email: "b@x.com", file: "shared.pdf" },
    { email: "c@x.com", file: "SHARED.PDF" }, // case-insensitive match
  ];
  const attachments = [onDisk("shared.pdf")];
  const m = computeAttachmentMatch(COLUMNS, rows, "file", attachments);
  assert.equal(m.rowsWithAttachment, 3, "every referencing row counts");
  assert.equal(m.attachmentTotal, 3, "the shared file is present for all three rows");
  assert.equal(m.missingAttachmentCount, 0);
});

test("a row whose attachment exceeds the per-message cap is counted oversize", () => {
  const rows = [{ email: "a@x.com", file: "huge.bin" }];
  const attachments = [onDisk("huge.bin", MAX_MESSAGE_BYTES + 1)];
  const m = computeAttachmentMatch(COLUMNS, rows, "file", attachments);
  assert.equal(m.oversizeRowCount, 1, "the over-cap row is flagged oversize");
  assert.equal(m.rowsWithAttachment, 1);
});

test("a DB-present file missing on disk is a miss, not counted toward attachmentTotal", () => {
  const rows = [{ email: "a@x.com", file: "gone.pdf" }];
  // A DAL row whose storage_path was never written to disk.
  const attachments = [
    { filename: "gone.pdf", storage_path: "never-written.bin", size_bytes: 10 },
  ];
  const m = computeAttachmentMatch(COLUMNS, rows, "file", attachments);
  assert.equal(m.rowsWithAttachment, 1, "the row matched a DB entry");
  assert.equal(m.attachmentTotal, 0, "but the file is absent on disk");
  assert.equal(m.missingAttachmentCount, 1, "an off-disk file is a blocking miss");
  assert.deepEqual(m.missingAttachmentFilenames, ["gone.pdf"]);
});

test("a null attachment column yields the zero/empty case", () => {
  const rows = [{ email: "a@x.com", file: "one.pdf" }];
  const m = computeAttachmentMatch(COLUMNS, rows, null, [onDisk("one.pdf")]);
  assert.equal(m.attachmentColumn, null);
  assert.equal(m.rowsWithAttachment, 0);
  assert.equal(m.attachmentTotal, 0);
  assert.equal(m.missingAttachmentCount, 0);
  assert.equal(m.oversizeRowCount, 0);
  assert.equal(m.sampleAttachment, null);
});
