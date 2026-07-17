/**
 * Argument-contract tests (SC-1 / SC-2 / SC-4).
 *
 * These assert the CLI's argument SURFACE, most importantly the security
 * guarantee (SC-2 / T-081-01): there is NO `--password` / `--smtp-pass` option,
 * so `parseArgs` strict mode REJECTS them — a secret can never travel in argv.
 *
 * node:test idiom mirrors lib/worker/maintenance.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs } from "../src/args.js";

test("csv + template only → dry mode with both paths set (SC-1)", () => {
  const o = parseCliArgs(["--csv", "d.csv", "--template", "m.txt"]);
  assert.equal(o.mode, "dry");
  assert.equal(o.csv, "d.csv");
  assert.equal(o.template, "m.txt");
});

test("--send → live mode", () => {
  const o = parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--send"]);
  assert.equal(o.mode, "live");
});

test("--test ADDR → test mode carrying the test address", () => {
  const o = parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--test", "you@x"]);
  assert.equal(o.mode, "test");
  assert.equal(o.testAddr, "you@x");
});

test("--test with no address throws, naming --test", () => {
  assert.throws(
    () => parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--test"]),
    /--test/,
  );
});

test("unknown --password flag is rejected by strict parseArgs (SC-2)", () => {
  assert.throws(
    () => parseCliArgs(["--csv", "d.csv", "--password", "hunter2"]),
    /password|unknown/i,
  );
});

test("unknown --smtp-pass flag is rejected by strict parseArgs (SC-2)", () => {
  assert.throws(
    () => parseCliArgs(["--smtp-pass", "secret"]),
    /smtp-pass|unknown/i,
  );
});

test("--delay-ms abc throws naming --delay-ms (never degrades to NaN) (T-081-05)", () => {
  assert.throws(
    () => parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--delay-ms", "abc"]),
    /--delay-ms/,
  );
});

test("--delay-ms with a valid positive number is coerced", () => {
  const o = parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--delay-ms", "1500"]);
  assert.equal(o.delayMs, 1500);
});

test("--email-column override is honored (spaces in the name allowed)", () => {
  const o = parseCliArgs(["--csv", "d.csv", "--template", "m.txt", "--email-column", "Work Email"]);
  assert.equal(o.emailColumn, "Work Email");
});
