/**
 * detectAttachmentColumn tests (ATCH-01).
 *
 * Mirrors the detectEmailColumn contract (lib/core/csv.ts): a two-stage
 * heuristic that supplies only the DEFAULT for the human confirm/override step
 * downstream — header-name hints first, then content sampling, else null.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectAttachmentColumn } from "./attachment-column";
import type { Row } from "./csv";

function rowsFrom(col: string, values: string[]): Row[] {
  return values.map((v) => ({ [col]: v }));
}

test("detects an exact 'attachment' header hint", () => {
  const cols = ["email", "attachment"];
  const rows: Row[] = [{ email: "a@x.com", attachment: "a.pdf" }];
  assert.equal(detectAttachmentColumn(cols, rows), "attachment");
});

test("detects a 'file' header hint", () => {
  const cols = ["email", "file"];
  const rows: Row[] = [{ email: "a@x.com", file: "a.pdf" }];
  assert.equal(detectAttachmentColumn(cols, rows), "file");
});

test("detects an 'attachment_file' header hint", () => {
  const cols = ["email", "attachment_file"];
  const rows: Row[] = [{ email: "a@x.com", attachment_file: "a.pdf" }];
  assert.equal(detectAttachmentColumn(cols, rows), "attachment_file");
});

test("normalizes header casing/whitespace before matching", () => {
  const cols = ["Email", "  Filename  "];
  const rows: Row[] = [{ Email: "a@x.com", "  Filename  ": "a.pdf" }];
  assert.equal(detectAttachmentColumn(cols, rows), "  Filename  ");
});

test("falls back to content sampling when no header hint matches", () => {
  // 'ref' is not a hint, but its cells all look like filenames; 'name' does not.
  const cols = ["name", "ref"];
  const rows: Row[] = [
    { name: "Alice", ref: "invoice-1.pdf" },
    { name: "Bob", ref: "invoice-2.pdf" },
    { name: "Cara", ref: "invoice-3.docx" },
  ];
  assert.equal(detectAttachmentColumn(cols, rows), "ref");
});

test("returns null when nothing looks like an attachment column", () => {
  const cols = ["name", "city"];
  const rows: Row[] = [
    { name: "Alice", city: "Paris" },
    { name: "Bob", city: "Berlin" },
  ];
  assert.equal(detectAttachmentColumn(cols, rows), null);
});

test("content sampling requires a majority of filename-shaped cells (> 0.7)", () => {
  const cols = ["ref"];
  const rows: Row[] = [
    { ref: "a.pdf" },
    { ref: "plain text" },
    { ref: "more text" },
    { ref: "still text" },
  ];
  // Only 1/4 cells look like a filename → below threshold → null.
  assert.equal(detectAttachmentColumn(cols, rows), null);
});
