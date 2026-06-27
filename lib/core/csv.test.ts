import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/core/csv.ts — the papaparse-backed CSV parser that replaces the
// CLI's naive split-at-first-comma (CSV-02). Must handle header mode, BOM
// stripping (PITFALLS #12), quoted fields with embedded commas, CRLF line
// endings, and validate recipient emails (CONCERNS.md gap, CSV-04 foundation).
const { parseCsv } = await import("./csv");

test("parses a header row into row objects keyed by header names + ordered columns", () => {
  const out = parseCsv("email,name\na@x.com,Ada\nb@x.com,Bo\n");
  assert.deepEqual(out.columns, ["email", "name"]);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[0], { email: "a@x.com", name: "Ada" });
  assert.deepEqual(out.rows[1], { email: "b@x.com", name: "Bo" });
});

test("strips a leading UTF-8 BOM from the first header (PITFALLS #12)", () => {
  const out = parseCsv("﻿email,name\na@x.com,Ada\n");
  assert.deepEqual(out.columns, ["email", "name"]);
  assert.equal(out.rows[0].email, "a@x.com");
  // The {{email}} token would never match if the header were "﻿email".
  assert.ok(!out.columns[0].includes("﻿"));
});

test("keeps a quoted field containing a comma as ONE field (the CLI split bug)", () => {
  const out = parseCsv('email,note\na@x.com,"Hello, world"\n');
  assert.equal(out.rows[0].note, "Hello, world");
  assert.deepEqual(out.columns, ["email", "note"]);
});

test("handles CRLF line endings and ignores a blank trailing line", () => {
  const out = parseCsv("email,name\r\na@x.com,Ada\r\nb@x.com,Bo\r\n\r\n");
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[1].name, "Bo");
});

test("flags/counts an invalid recipient email (validation at parse — CONCERNS.md gap)", () => {
  const out = parseCsv("email,name\nnot-an-email,Ada\nb@x.com,Bo\n");
  assert.equal(out.invalidEmailCount, 1);
  // The valid row is still parsed.
  assert.equal(out.rows.length, 2);
});

test("reports zero invalid emails for an all-valid file", () => {
  const out = parseCsv("email,name\na@x.com,Ada\nb@x.com,Bo\n");
  assert.equal(out.invalidEmailCount, 0);
});

test("accepts a Buffer input (worker reads file as bytes)", () => {
  const out = parseCsv(Buffer.from("email,name\na@x.com,Ada\n", "utf8"));
  assert.equal(out.rows[0].email, "a@x.com");
});
