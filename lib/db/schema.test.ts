import { test } from "node:test";
import assert from "node:assert/strict";

import * as schema from "./schema";
import { getTableConfig } from "drizzle-orm/sqlite-core";

// These tests assert on the SCHEMA DEFINITION objects only.
// They do NOT open a real database connection (D-04: only lib/db/client.ts opens SQLite).

const TENANT_OWNED = [
  "smtp_configs",
  "recipient_sets",
  "templates",
  "campaigns",
] as const;

const ALL_TABLES = [
  ...TENANT_OWNED,
  "send_records",
  "attachments",
] as const;

function columnNames(table: unknown): string[] {
  return getTableConfig(table as never).columns.map((c) => c.name);
}

function propertyKeys(table: unknown): string[] {
  // Drizzle exposes columns as own enumerable properties keyed by the JS field name.
  return Object.keys(table as Record<string, unknown>);
}

test("schema exposes exactly the six v1 table objects", () => {
  for (const name of ALL_TABLES) {
    assert.ok(
      (schema as Record<string, unknown>)[name],
      `expected schema to export table object '${name}'`,
    );
  }
});

test("every tenant-owned table carries a userId column (AUTH-02)", () => {
  for (const name of TENANT_OWNED) {
    const table = (schema as Record<string, unknown>)[name];
    const keys = propertyKeys(table);
    assert.ok(
      keys.includes("userId"),
      `tenant-owned table '${name}' must expose a userId column for multi-tenant scoping`,
    );
  }
});

test("smtp_configs stores only the encrypted credential triple + explicit secure (SMTP-04)", () => {
  const cols = columnNames(schema.smtp_configs);

  // Encrypted triple present (AES-256-GCM parts), never plaintext.
  for (const part of ["password_enc", "password_iv", "password_tag"]) {
    assert.ok(
      cols.includes(part),
      `smtp_configs must expose encrypted credential column '${part}'`,
    );
  }

  // Explicit secure boolean — NOT inferred from port (PITFALLS #3).
  assert.ok(
    cols.includes("secure"),
    "smtp_configs must expose an explicit 'secure' column",
  );

  // No plaintext password column: any column containing 'password' MUST be one of the encrypted parts.
  const plaintextPassword = cols.filter(
    (c) =>
      c.toLowerCase().includes("password") &&
      !["password_enc", "password_iv", "password_tag"].includes(c),
  );
  assert.deepEqual(
    plaintextPassword,
    [],
    `smtp_configs must NOT expose a plaintext password column (found: ${plaintextPassword.join(", ")})`,
  );
});

test("send_records has a status column + per-recipient audit fields (SEND-03/04/06)", () => {
  const cols = columnNames(schema.send_records);
  for (const c of ["status", "message_id", "error", "attempts", "sent_at"]) {
    assert.ok(
      cols.includes(c),
      `send_records must expose '${c}' (per-recipient state machine + audit)`,
    );
  }
});

test("send_records enforces UNIQUE(campaign_id, to_addr) for idempotent materialization (SEND-06)", () => {
  const config = getTableConfig(schema.send_records);
  // Collect unique constraints from both uniqueConstraints and unique indexes.
  const uniqueColumnSets: string[][] = [];

  for (const uc of config.uniqueConstraints ?? []) {
    uniqueColumnSets.push(uc.columns.map((c) => c.name));
  }
  for (const idx of config.indexes ?? []) {
    if (idx.config.unique) {
      const names = idx.config.columns
        .map((c) => (c as { name?: string }).name)
        .filter((n): n is string => typeof n === "string");
      uniqueColumnSets.push(names);
    }
  }

  const hasGuard = uniqueColumnSets.some(
    (set) =>
      set.length === 2 &&
      set.includes("campaign_id") &&
      set.includes("to_addr"),
  );

  assert.ok(
    hasGuard,
    `send_records must declare a UNIQUE constraint over (campaign_id, to_addr); found unique sets: ${JSON.stringify(
      uniqueColumnSets,
    )}`,
  );
});
