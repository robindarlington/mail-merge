import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/core/fill.ts — the generalized {{column}} merge engine lifted and
// fixed from the CLI's hard-coded {{email}}/{{password}} substitution.
// Contract (EDIT-03): fill substitutes ARBITRARY column tokens and is applied
// to BOTH subject and body (the CLI bug where subjects were never filled).
const { fill, fillMessage } = await import("./fill");

test("fill substitutes an arbitrary column token (not just email/password)", () => {
  assert.equal(fill("Hi {{name}}", { name: "Ada" }), "Hi Ada");
});

test("fill substitutes multiple distinct tokens from the row", () => {
  assert.equal(
    fill("{{email}} / {{password}}", { email: "a@x.com", password: "s3cr3t" }),
    "a@x.com / s3cr3t",
  );
});

test("fill replaces every occurrence of the same token", () => {
  assert.equal(
    fill("{{name}}, hello {{name}}!", { name: "Bo" }),
    "Bo, hello Bo!",
  );
});

test("fill leaves an unmatched token intact (documented rule: pass-through)", () => {
  assert.equal(fill("Hi {{missing}}", { name: "Ada" }), "Hi {{missing}}");
});

test("fill tolerates inner whitespace in the token braces", () => {
  assert.equal(fill("Hi {{ name }}", { name: "Ada" }), "Hi Ada");
});

test("fill does not treat replacement text containing $ as a regex replacement special", () => {
  // A row value of "$1" must be inserted literally, not interpreted as a backref.
  assert.equal(fill("Price: {{amt}}", { amt: "$1,000" }), "Price: $1,000");
});

test("fillMessage applies fill to BOTH subject and body (EDIT-03 — fixes the CLI subject bug)", () => {
  const out = fillMessage(
    { subject: "Welcome {{name}}", body: "Your login is {{email}}" },
    { name: "Ada", email: "ada@x.com" },
  );
  assert.equal(out.subject, "Welcome Ada");
  assert.equal(out.body, "Your login is ada@x.com");
});
