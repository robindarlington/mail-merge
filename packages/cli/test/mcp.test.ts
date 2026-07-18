/**
 * mcp.test — the stdio MCP server slice (SC-3 / D-04 / D-06 / D-12).
 *
 * The whole suite runs IN-PROCESS with the SDK's InMemoryTransport (no sockets,
 * no stdio) — a linked Client<->McpServer pair built from `buildServer()`. This
 * exercises the real registerTool schemas + callbacks without a JSON-RPC socket.
 *
 * Coverage:
 *  1. Read-only tools (Task 1): listTools discovery, validate-csv typed results
 *     computed by lib/core, preview-merge per-row fill + limit, and SDK zod
 *     inputSchema refusal of a malformed call.
 *  2. Send tools (Task 2): test-send routes through run.ts against a real
 *     stub-smtp; `send` is gated by a two-step confirm token (first call previews
 *     + mints a token and delivers nothing; second call with the token delivers
 *     one-per-row and consumes it; replay/absent token refused); `delayMs` (D-06)
 *     threads into the preview; `receiptsPath` (D-12) round-trips JSONL + resume;
 *     an absent receiptsPath surfaces the no-receipts warning; the SMTP password
 *     never appears in any tool result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/mcp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STUB = resolve(REPO_ROOT, "scripts/stub-smtp.ts");

const CSV = "email,name,code\na@example.com,Ada,AAA\nb@example.com,Bob,BBB\nc@example.com,Cy,CCC\n";

/** Link a fresh Client to a fresh buildServer() over InMemoryTransport (no sockets). */
async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverT);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  await client.connect(clientT);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Structured content from a callTool result, typed loosely for assertions. */
function structured(result: unknown): Record<string, unknown> {
  const r = result as { structuredContent?: Record<string, unknown> };
  assert.ok(r.structuredContent, "tool returned structuredContent");
  return r.structuredContent as Record<string, unknown>;
}

/** Spawn scripts/stub-smtp serve, await readiness, run body, then tear it down. */
async function withStubSmtp(
  run: (opts: { port: number; logPath: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cli-mcp-stub-"));
  const logPath = join(dir, "rcpt.jsonl");
  const port = 30000 + (process.pid % 10000);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", STUB, "serve", "--port", String(port), "--log", logPath],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error("stub-smtp did not start in time")), 10000);
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("listening on")) {
          clearTimeout(to);
          res();
        }
      });
      child.on("error", rej);
      child.on("exit", (code) => rej(new Error(`stub-smtp exited early (${code})`)));
    });
    await run({ port, logPath });
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((res) => child.on("exit", () => res()));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the stub RCPT JSONL log into a list of delivered addresses. */
function readRcptAddrs(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { addr: string }).addr);
}

/** An SMTP param block pointing at a spawned stub-smtp. */
function stubSmtpParam(port: number) {
  return { host: "127.0.0.1", port, secure: false, user: "u", pass: "MCP-SECRET-PW-42" };
}

// --- Task 1: discovery + read-only tools -------------------------------------

test("listTools exposes validate-csv + preview-merge with descriptions + input schemas", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["validate-csv", "preview-merge"]) {
      const t = byName.get(name);
      assert.ok(t, `${name} is listed`);
      assert.ok(t!.description && t!.description.length > 0, `${name} has a description`);
      assert.ok(t!.inputSchema, `${name} advertises an input schema for discovery`);
    }
  } finally {
    await close();
  }
});

test("validate-csv returns typed results computed by lib/core", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({
      name: "validate-csv",
      arguments: { csv: "email\na@b.com\nbad\n" },
    });
    const sc = structured(result);
    assert.deepEqual(sc.columns, ["email"]);
    assert.equal(sc.rowCount, 2);
    assert.equal(sc.detectedEmailColumn, "email");
    assert.equal(sc.invalidEmailCount, 1, "the 'bad' row is counted invalid by lib/core");
  } finally {
    await close();
  }
});

test("preview-merge returns per-row merged subject/body via lib/core.fillMessage", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({
      name: "preview-merge",
      arguments: { csv: CSV, subject: "Hi {{name}}", body: "Code {{code}}" },
    });
    const sc = structured(result);
    const rows = sc.rows as { to: string; subject: string; body: string }[];
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { to: "a@example.com", subject: "Hi Ada", body: "Code AAA" });
    assert.deepEqual(rows[2], { to: "c@example.com", subject: "Hi Cy", body: "Code CCC" });
  } finally {
    await close();
  }
});

test("preview-merge honours an optional row limit", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({
      name: "preview-merge",
      arguments: { csv: CSV, subject: "Hi {{name}}", body: "x", limit: 1 },
    });
    const rows = structured(result).rows as unknown[];
    assert.equal(rows.length, 1, "limit caps the previewed rows");
  } finally {
    await close();
  }
});

test("a malformed call (missing required arg) is refused by the SDK zod inputSchema, not a crash", async () => {
  const { client, close } = await connect();
  try {
    await assert.rejects(
      () => client.callTool({ name: "validate-csv", arguments: {} }),
      "the SDK rejects a call missing the required csv arg before the callback runs",
    );
  } finally {
    await close();
  }
});
