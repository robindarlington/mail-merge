/**
 * Shared compose-form schema tests (EDIT-01).
 *
 * Proves the ONE schema parsed by both the client RHF resolver and the server
 * action guard: subject/body required with the exact UI-SPEC messages, and the
 * RFC 5322 subject line cap (998 chars, A7). Mirrors lib/csv/schema.test.ts
 * zod-4 safeParse idioms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { composeFormSchema } = await import("./schema");

/** Assert a safeParse failure carries the expected message on some issue. */
function failsWithMessage(input: unknown, message: string) {
  const res = composeFormSchema.safeParse(input);
  assert.equal(res.success, false, "expected validation to fail");
  if (!res.success) {
    assert.ok(
      res.error.issues.some((i) => i.message === message),
      `expected an issue with message: ${message}`,
    );
  }
}

test("composeFormSchema accepts a non-empty subject and body", () => {
  const res = composeFormSchema.safeParse({ subject: "Hi", body: "Hello" });
  assert.equal(res.success, true);
});

test("composeFormSchema rejects a blank subject with the UI-SPEC message", () => {
  failsWithMessage({ subject: "", body: "Hello" }, "Add a subject before saving.");
});

test("composeFormSchema rejects a whitespace-only subject", () => {
  failsWithMessage(
    { subject: "   ", body: "Hello" },
    "Add a subject before saving.",
  );
});

test("composeFormSchema rejects a blank body with the UI-SPEC message", () => {
  failsWithMessage({ subject: "Hi", body: "" }, "Write a message before saving.");
});

test("composeFormSchema rejects a whitespace-only body", () => {
  failsWithMessage(
    { subject: "Hi", body: "   " },
    "Write a message before saving.",
  );
});

test("composeFormSchema rejects a subject longer than 998 chars (RFC 5322, A7)", () => {
  const res = composeFormSchema.safeParse({
    subject: "a".repeat(999),
    body: "Hello",
  });
  assert.equal(res.success, false);
});

test("composeFormSchema accepts a subject of exactly 998 chars", () => {
  const res = composeFormSchema.safeParse({
    subject: "a".repeat(998),
    body: "Hello",
  });
  assert.equal(res.success, true);
});
