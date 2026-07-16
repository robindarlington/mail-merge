/**
 * Unit tests for `toResultsCsv` (HIST-03) — the pure results-CSV serializer.
 *
 * No DB, no Clerk, no filesystem: `toResultsCsv` is a pure function over plain
 * send-record-shaped objects, so these tests exercise it directly. They pin the
 * two safety disciplines the export route depends on:
 *
 *  - RFC-4180 field quoting: a field containing a comma, double-quote, CR, or LF
 *    is wrapped in double quotes with embedded quotes doubled (T-06-18).
 *  - Spreadsheet formula-injection neutralization: a field whose first char is
 *    `=`, `+`, `-`, `@`, a tab, or a CR is prefixed with a single quote BEFORE
 *    quoting, so Excel/Sheets cannot execute it as a formula (T-06-18).
 *
 * Plus the interrupted-vs-failed label distinction (mirrors the UI) and the
 * empty-input header-only contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { toResultsCsv } from "@/lib/campaign/results-csv";

type Row = {
  to_addr: string;
  status: string;
  error: string | null;
  message_id: string | null;
  sent_at: number | null;
  attachment?: string;
};

const HEADER = "Recipient,Status,Reason,Message ID,Sent at,Attachment";

/** Split a CSV string into its RFC-4180 CRLF-delimited lines. */
function lines(csv: string): string[] {
  return csv.split("\r\n");
}

test("empty input returns only the header line", () => {
  const csv = toResultsCsv([]);
  assert.equal(csv, HEADER);
});

test("header is the first line and rows terminate with CRLF", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "sent", error: null, message_id: "<1@x>", sent_at: 1_700_000_000 },
  ];
  const csv = toResultsCsv(rows);
  const parts = lines(csv);
  assert.equal(parts[0], HEADER);
  assert.equal(parts.length, 2);
  assert.ok(parts[1].startsWith("a@x.com,sent,"));
});

test("a field containing a comma is wrapped in double quotes", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "failed", error: "auth failed, retry later", message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  assert.ok(
    csv.includes('"auth failed, retry later"'),
    "comma-bearing reason must be double-quoted",
  );
});

test("a field containing a double-quote doubles the quote and wraps", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "failed", error: 'he said "no"', message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  assert.ok(
    csv.includes('"he said ""no"""'),
    "embedded double-quote must be doubled and the field wrapped",
  );
});

test("a field containing a newline is wrapped in double quotes", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "failed", error: "line1\nline2", message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  assert.ok(csv.includes('"line1\nline2"'), "newline-bearing field must be wrapped");
});

test("formula-injection: =, +, -, @, and leading tab are each prefixed with a single quote", () => {
  const cases: Array<[string, string]> = [
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1234567", "'+1234567"],
    ["-1234567", "'-1234567"],
    ["@cmd", "'@cmd"],
  ];
  for (const [payload, neutralized] of cases) {
    const rows: Row[] = [
      { to_addr: payload, status: "sent", error: null, message_id: null, sent_at: null },
    ];
    const csv = toResultsCsv(rows);
    assert.ok(
      csv.includes(neutralized),
      `payload ${JSON.stringify(payload)} must be neutralized to ${JSON.stringify(neutralized)}`,
    );
  }

  // A leading tab: neutralized with a leading single quote, then RFC-4180 has no
  // special handling for tab, so the prefixed value appears verbatim.
  const tabRows: Row[] = [
    { to_addr: "\thidden", status: "sent", error: null, message_id: null, sent_at: null },
  ];
  const tabCsv = toResultsCsv(tabRows);
  assert.ok(tabCsv.includes("'\thidden"), "leading-tab field must be prefixed with a single quote");
});

test("interrupted-error row emits the 'interrupted' status label, distinct from a plain 'failed' row", () => {
  const rows: Row[] = [
    {
      to_addr: "int@x.com",
      status: "failed",
      error: "interrupted: worker crashed mid-send",
      message_id: null,
      sent_at: null,
    },
    { to_addr: "fail@x.com", status: "failed", error: "mailbox full", message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  const parts = lines(csv);
  // Row 1 → interrupted label; Row 2 → plain failed label.
  assert.ok(parts[1].startsWith("int@x.com,interrupted,"), "interrupted-prefixed error → 'interrupted' label");
  assert.ok(parts[2].startsWith("fail@x.com,failed,"), "plain error → raw 'failed' label");
});

test("sent_at renders as an ISO timestamp when set and empty when null", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "sent", error: null, message_id: "<m@x>", sent_at: 1_700_000_000 },
    { to_addr: "b@x.com", status: "pending", error: null, message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  const parts = lines(csv);
  const iso = new Date(1_700_000_000 * 1000).toISOString();
  // Sent at is the 5th field; the appended empty Attachment field trails it.
  assert.ok(parts[1].endsWith(`${iso},`), "set sent_at renders as ISO timestamp");
  // Unsent row ends with an empty Attachment field (trailing comma, nothing after).
  assert.ok(parts[2].endsWith(","), "null sent_at renders as an empty field");
});

test("reason renders the message-only error string, empty when null", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "sent", error: null, message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  const parts = lines(csv);
  // Recipient,Status,Reason,Message ID,Sent at,Attachment → reason is the 3rd
  // field, empty; message id, sent at, and attachment are all empty too.
  assert.equal(parts[1], "a@x.com,sent,,,,");
});

test("attachment renders as the trailing field and is formula-injection-safe", () => {
  const rows: Row[] = [
    { to_addr: "a@x.com", status: "sent", error: null, message_id: null, sent_at: null, attachment: "invoice.pdf" },
    { to_addr: "b@x.com", status: "sent", error: null, message_id: null, sent_at: null, attachment: "=cmd().pdf" },
    { to_addr: "c@x.com", status: "sent", error: null, message_id: null, sent_at: null },
  ];
  const csv = toResultsCsv(rows);
  const parts = lines(csv);
  assert.ok(parts[1].endsWith(",invoice.pdf"), "a plain filename is the trailing field");
  assert.ok(parts[2].endsWith(",'=cmd().pdf"), "a formula-leader filename is neutralized with a single quote");
  assert.ok(parts[3].endsWith(","), "a row with no attachment renders an empty trailing field");
});
