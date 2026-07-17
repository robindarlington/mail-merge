/**
 * Merge-parity test (SC-4).
 *
 * Proves the CLI does NOT re-implement merge: `mergeRow` (bin's helper) must be
 * byte-identical to `lib/core.fillMessage` over the same template + row — covering
 * the `$`-literal case ("X$1" must NOT be treated as a regex replacement special)
 * and spaces-in-column-key case ("{{First Name}}"). loadTemplate is exercised
 * against a real temp file (node:test idiom from lib/worker/maintenance.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeRow } from "../src/bin.js";
import { loadTemplate } from "../src/template.js";
import { fillMessage } from "../../../lib/core/index.js";

test("mergeRow is byte-identical to lib/core.fillMessage ($ literal + spaced key)", () => {
  const tpl = { subject: "Hi {{First Name}}", body: "Your code {{code}}" };
  const row = { "First Name": "Ada", code: "X$1" };

  assert.deepEqual(mergeRow(tpl, row), fillMessage(tpl, row));

  const merged = mergeRow(tpl, row);
  assert.equal(merged.subject, "Hi Ada");
  assert.equal(merged.body, "Your code X$1");
});

test("loadTemplate extracts the Subject line + remainder, then merges via lib/core", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-parity-"));
  const path = join(dir, "msg.txt");
  writeFileSync(path, "Subject: Hi {{First Name}}\n\nYour code {{code}}\n");
  try {
    const tpl = loadTemplate(path);
    assert.equal(tpl.subject, "Hi {{First Name}}");
    assert.equal(tpl.body, "Your code {{code}}\n");

    const row = { "First Name": "Ada", code: "X$1" };
    assert.deepEqual(mergeRow(tpl, row), fillMessage(tpl, row));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
