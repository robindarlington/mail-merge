/**
 * Upload guard + confirm-column schema tests (CSV-01 / T-3-DOS).
 *
 * Proves the size/type guard rejects non-CSV and oversized files with the
 * UI-SPEC messages BEFORE any parse/write, and that confirmColumnSchema requires
 * a non-empty chosen column. Mirrors lib/smtp/schema.ts zod-4 idioms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  MAX_UPLOAD_BYTES,
  MAX_ROWS,
  uploadFileSchema,
  confirmColumnSchema,
} = await import("./schema");

test("MAX_UPLOAD_BYTES is 4 MB and MAX_ROWS is 5000", () => {
  assert.equal(MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_ROWS, 5000);
});

test("uploadFileSchema accepts a .csv / text/csv file under 4 MB", () => {
  const res = uploadFileSchema.safeParse({
    name: "list.csv",
    type: "text/csv",
    size: 1024,
  });
  assert.equal(res.success, true);
});

test("uploadFileSchema accepts the application/vnd.ms-excel csv mime", () => {
  const res = uploadFileSchema.safeParse({
    name: "list.csv",
    type: "application/vnd.ms-excel",
    size: 1024,
  });
  assert.equal(res.success, true);
});

test("uploadFileSchema rejects a non-.csv file (wrong extension)", () => {
  const res = uploadFileSchema.safeParse({
    name: "list.txt",
    type: "text/plain",
    size: 1024,
  });
  assert.equal(res.success, false);
});

test("uploadFileSchema rejects a file larger than MAX_UPLOAD_BYTES", () => {
  const res = uploadFileSchema.safeParse({
    name: "big.csv",
    type: "text/csv",
    size: MAX_UPLOAD_BYTES + 1,
  });
  assert.equal(res.success, false);
});

test("confirmColumnSchema rejects an empty emailColumn", () => {
  const res = confirmColumnSchema.safeParse({ emailColumn: "" });
  assert.equal(res.success, false);
});

test("confirmColumnSchema accepts a chosen emailColumn", () => {
  const res = confirmColumnSchema.safeParse({ emailColumn: "Email" });
  assert.equal(res.success, true);
});
