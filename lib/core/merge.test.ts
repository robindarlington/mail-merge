import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/core/merge.ts — the pure merge-gap engine (PREV-02/03).
// Contract: extractTokens lists the {{column}} keys of a template (first-seen
// order, de-duplicated, whitespace-tolerant); analyzeMerge classifies each
// token against a row + column set as `empty` (column exists, value blank) or
// `unknown` (key is NOT a column). A present token appears in neither array.
const { extractTokens, analyzeMerge } = await import("./merge");

test("extractTokens returns token keys in first-seen order, de-duplicated", () => {
  assert.deepEqual(extractTokens("{{a}} {{ a }} {{b}}"), ["a", "b"]);
});

test("extractTokens preserves first-seen order across the template", () => {
  assert.deepEqual(
    extractTokens("Hi {{name}}, you owe {{amount}} — thanks {{name}}"),
    ["name", "amount"],
  );
});

test("extractTokens tolerates inner whitespace in the braces", () => {
  assert.deepEqual(extractTokens("{{ name }} {{amount}}"), ["name", "amount"]);
});

test("extractTokens dedups a spaced column key across differing inner spacing", () => {
  assert.deepEqual(
    extractTokens("{{First Name}} {{ First Name }}"),
    ["First Name"],
  );
});

test("extractTokens over a token-free string returns []", () => {
  assert.deepEqual(extractTokens("no tokens here"), []);
});

test("extractTokens over an empty string returns []", () => {
  assert.deepEqual(extractTokens(""), []);
});

test("analyzeMerge classifies a column token with a blank row value as empty", () => {
  const out = analyzeMerge("Hi {{name}}", { name: "" }, ["name"]);
  assert.deepEqual(out.empty, ["name"]);
  assert.deepEqual(out.unknown, []);
});

test("analyzeMerge treats a whitespace-only value as empty", () => {
  const out = analyzeMerge("Hi {{name}}", { name: "   " }, ["name"]);
  assert.deepEqual(out.empty, ["name"]);
  assert.deepEqual(out.unknown, []);
});

test("analyzeMerge classifies a token whose key is NOT a column as unknown", () => {
  const out = analyzeMerge("Hi {{typo}}", { name: "Ada" }, ["name"]);
  assert.deepEqual(out.unknown, ["typo"]);
  assert.deepEqual(out.empty, []);
});

test("analyzeMerge reports a present (column + non-blank) token in NEITHER array", () => {
  const out = analyzeMerge("Hi {{name}}", { name: "Ada" }, ["name"]);
  assert.deepEqual(out.empty, []);
  assert.deepEqual(out.unknown, []);
});

test("analyzeMerge never reports an unknown key as also empty (unknown wins)", () => {
  // `typo` is missing from row AND not a column → unknown only, never empty.
  const out = analyzeMerge("{{typo}}", {}, ["name"]);
  assert.deepEqual(out.unknown, ["typo"]);
  assert.deepEqual(out.empty, []);
});

test("analyzeMerge classifies a blank-valued spaced column key as empty", () => {
  const out = analyzeMerge("{{First Name}}", { "First Name": "" }, [
    "First Name",
  ]);
  assert.deepEqual(out.empty, ["First Name"]);
  assert.deepEqual(out.unknown, []);
});

test("analyzeMerge classifies an unknown spaced key as unknown", () => {
  const out = analyzeMerge("{{Full Name}}", { "First Name": "Ada" }, [
    "First Name",
  ]);
  assert.deepEqual(out.unknown, ["Full Name"]);
  assert.deepEqual(out.empty, []);
});

test("analyzeMerge separates mixed empty + unknown + present tokens", () => {
  const out = analyzeMerge(
    "{{name}} {{amount}} {{typo}}",
    { name: "Ada", amount: "" },
    ["name", "amount"],
  );
  assert.deepEqual(out.empty, ["amount"]);
  assert.deepEqual(out.unknown, ["typo"]);
});
