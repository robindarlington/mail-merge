import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/core/csv.ts — the papaparse-backed CSV parser that replaces the
// CLI's naive split-at-first-comma (CSV-02). Must handle header mode, BOM
// stripping (PITFALLS #12), quoted fields with embedded commas, CRLF line
// endings, and validate recipient emails (CONCERNS.md gap, CSV-04 foundation).
const { parseCsv, detectEmailColumn, countInvalidEmails } = await import(
  "./csv"
);

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

test("returns empty parseErrors for a well-formed CSV (WR-01)", () => {
  const out = parseCsv("email,name\na@x.com,Ada\nb@x.com,Bo\n");
  assert.equal(out.parseErrors.length, 0);
});

test("surfaces papaparse structural errors for a malformed CSV (WR-01)", () => {
  // Row 2 has only 1 field; papaparse should report a TooFewFields FieldMismatch error.
  const out = parseCsv("email,name\na@x.com,Ada\nb@x.com\n");
  const fieldErrors = out.parseErrors.filter((e) => e.type === "FieldMismatch");
  assert.ok(fieldErrors.length > 0, "expected at least one FieldMismatch error");
  assert.equal(fieldErrors[0].code, "TooFewFields");
});

// --- detectEmailColumn (CSV-03) --------------------------------------------
// Two-stage heuristic: normalized header-name match first, content-sampling
// fallback second, with human confirmation as the ultimate gate downstream.

test("detectEmailColumn matches an exact `Email` header by name", () => {
  const out = parseCsv("Email,Name\na@x.com,Ada\n");
  assert.equal(detectEmailColumn(out.columns, out.rows), "Email");
});

test("detectEmailColumn matches a normalized `Work Email` header (includes 'email')", () => {
  const out = parseCsv("Work Email,Name\na@x.com,Ada\n");
  assert.equal(detectEmailColumn(out.columns, out.rows), "Work Email");
});

test("detectEmailColumn does NOT pick `mailing_city` (substring 'mail' but non-email content)", () => {
  const out = parseCsv(
    "mailing_city,name\nLondon,Ada\nParis,Bo\nBerlin,Cy\n",
  );
  // `mailing_city` contains 'mail' but not 'email'; its content is not email-like.
  assert.equal(detectEmailColumn(out.columns, out.rows), null);
});

test("detectEmailColumn falls back to content sampling when no header hints (>0.7 hit-rate)", () => {
  // No email-like header; the `contact` column is >70% valid emails.
  const out = parseCsv(
    "contact,name\na@b.com,Ada\nc@d.com,Bo\ne@f.com,Cy\nnot-an-email,Di\n",
  );
  assert.equal(detectEmailColumn(out.columns, out.rows), "contact");
});

test("detectEmailColumn returns null when no column looks like email", () => {
  const out = parseCsv("city,name\nLondon,Ada\nParis,Bo\n");
  assert.equal(detectEmailColumn(out.columns, out.rows), null);
});

// --- countInvalidEmails (CSV-04) -------------------------------------------
// Counts invalid rows in an ARBITRARY confirmed column (not the literal 'email').

test("countInvalidEmails counts invalid values in an arbitrary column (blank counts as invalid)", () => {
  const out = parseCsv(
    "contact,name\na@b.com,Ada\nnope,Bo\n,Cy\nc@d.com,Di\n",
  );
  // "nope" and "" are invalid; "a@b.com" and "c@d.com" are valid → 2.
  assert.equal(countInvalidEmails(out.rows, "contact"), 2);
});

test("countInvalidEmails returns 0 for a fully-valid column", () => {
  const out = parseCsv("contact,name\na@b.com,Ada\nc@d.com,Bo\n");
  assert.equal(countInvalidEmails(out.rows, "contact"), 0);
});
