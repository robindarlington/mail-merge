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

/** An SMTP param block pointing at a spawned stub-smtp. The stub disables
 *  STARTTLS, so tests opt out of the requireTls default EXPLICITLY (CR-01). */
function stubSmtpParam(port: number) {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls: false,
    user: "u",
    pass: "MCP-SECRET-PW-42",
  };
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
    // The SDK validates against the inputSchema BEFORE the callback runs and
    // returns an isError result (not a crash / not a silent success).
    const result = (await client.callTool({ name: "validate-csv", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(result.isError, true, "missing csv arg is refused, not run");
    assert.match(result.content[0].text, /validation/i, "the refusal is a schema-validation error");
  } finally {
    await close();
  }
});

// --- Task 2: send tools (test-send + send two-step token) --------------------

const NO_RECEIPTS_WARNING = "No receipts file will be written for this send.";

test("listTools also exposes test-send + send once wired", async () => {
  const { client, close } = await connect();
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["preview-merge", "send", "test-send", "validate-csv"]);
  } finally {
    await close();
  }
});

test("test-send routes through run.ts to stub-smtp; password never in the result", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "test-send",
        arguments: {
          csv: CSV,
          subject: "Hi {{name}}",
          body: "Code {{code}}",
          smtp: stubSmtpParam(port),
          from: "noreply@example.com",
          testAddr: "proof@me.com",
          delayMs: 0,
        },
      });
      const sc = structured(result);
      assert.equal(sc.attempted, 3);
      assert.equal(sc.sent, 3);
      assert.equal(sc.failed, 0);
      assert.equal(sc.receiptsPath, null, "no receiptsPath given → null");

      const addrs = readRcptAddrs(logPath);
      assert.equal(addrs.length, 3, "test mode delivered one message per row");
      assert.ok(addrs.every((a) => a === "proof@me.com"), "every message went to the single test address");

      assert.ok(
        !JSON.stringify(result).includes("MCP-SECRET-PW-42"),
        "the SMTP password never appears in the tool result",
      );
    } finally {
      await close();
    }
  });
});

test("secure:false WITHOUT requireTls:false refuses a no-STARTTLS server (CR-01 default)", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    try {
      // Omit requireTls entirely: the default (true) must REQUIRE the STARTTLS
      // upgrade, and the stub disables STARTTLS — so the send must fail closed
      // instead of authenticating over cleartext.
      const { requireTls: _omitted, ...noRequireTls } = stubSmtpParam(port);
      const result = (await client.callTool({
        name: "test-send",
        arguments: {
          csv: CSV,
          subject: "Hi {{name}}",
          body: "x",
          smtp: noRequireTls,
          from: "noreply@example.com",
          testAddr: "proof@me.com",
          delayMs: 0,
        },
      })) as { isError?: boolean };
      assert.equal(result.isError, true, "cleartext AUTH without STARTTLS is refused");
      assert.equal(readRcptAddrs(logPath).length, 0, "nothing was delivered in cleartext");
    } finally {
      await close();
    }
  });
});

test("send FIRST call (no token) previews + mints a token and delivers NOTHING", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "send",
        arguments: {
          csv: CSV,
          subject: "Hi {{name}}",
          body: "Code {{code}}",
          smtp: stubSmtpParam(port),
          from: "noreply@example.com",
          delayMs: 0,
        },
      });
      const sc = structured(result);
      const preview = sc.preview as Record<string, unknown>;
      assert.equal(preview.recipientCount, 3);
      assert.equal(preview.subject, "Hi {{name}}");
      assert.equal(preview.from, "noreply@example.com");
      assert.equal(preview.delayMs, 0);
      assert.equal(preview.receiptsPath, null);
      assert.equal(preview.receiptsWarning, NO_RECEIPTS_WARNING, "no path → explicit warning");
      assert.ok(typeof sc.confirmToken === "string" && (sc.confirmToken as string).length > 0);

      assert.equal(readRcptAddrs(logPath).length, 0, "the preview call delivered nothing");
      assert.ok(!JSON.stringify(result).includes("MCP-SECRET-PW-42"), "no password in the preview");
    } finally {
      await close();
    }
  });
});

test("send SECOND call with the token delivers one-per-row, consumes the token (replay refused)", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    const args = {
      csv: CSV,
      subject: "Hi {{name}}",
      body: "Code {{code}}",
      smtp: stubSmtpParam(port),
      from: "noreply@example.com",
      delayMs: 0,
    };
    try {
      const first = structured(await client.callTool({ name: "send", arguments: args }));
      const token = first.confirmToken as string;

      const second = await client.callTool({ name: "send", arguments: { ...args, confirmToken: token } });
      const sc = structured(second);
      assert.equal(sc.attempted, 3);
      assert.equal(sc.sent, 3);
      assert.equal(sc.failed, 0);
      assert.equal(sc.receiptsPath, null);
      assert.equal(sc.receiptsWarning, NO_RECEIPTS_WARNING, "final result carries the warning too");

      assert.deepEqual(
        readRcptAddrs(logPath).sort(),
        ["a@example.com", "b@example.com", "c@example.com"],
        "delivered one message per row",
      );

      // Replay the SAME token → refused, no new delivery.
      const replay = (await client.callTool({
        name: "send",
        arguments: { ...args, confirmToken: token },
      })) as { isError?: boolean };
      assert.equal(replay.isError, true, "a consumed token is refused");
      assert.equal(readRcptAddrs(logPath).length, 3, "replay added no deliveries");
    } finally {
      await close();
    }
  });
});

test("send with a wrong token is refused (isError, no delivery)", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    try {
      const result = (await client.callTool({
        name: "send",
        arguments: {
          csv: CSV,
          subject: "Hi {{name}}",
          body: "Code {{code}}",
          smtp: stubSmtpParam(port),
          from: "noreply@example.com",
          delayMs: 0,
          confirmToken: "not-a-real-token",
        },
      })) as { isError?: boolean };
      assert.equal(result.isError, true, "an unknown token is refused");
      assert.equal(readRcptAddrs(logPath).length, 0, "no delivery on a bad token");
    } finally {
      await close();
    }
  });
});

test("send preview delayMs threads through (override honoured; default 3000 when absent) — D-06", async () => {
  const { client, close } = await connect();
  const base = {
    csv: CSV,
    subject: "Hi {{name}}",
    body: "x",
    smtp: { host: "127.0.0.1", port: 25, secure: false, user: "u", pass: "MCP-SECRET-PW-42" },
    from: "noreply@example.com",
  };
  try {
    const overridden = structured(await client.callTool({ name: "send", arguments: { ...base, delayMs: 50 } }));
    assert.equal((overridden.preview as Record<string, unknown>).delayMs, 50, "explicit delayMs is echoed");

    const defaulted = structured(await client.callTool({ name: "send", arguments: base }));
    assert.equal((defaulted.preview as Record<string, unknown>).delayMs, 3000, "absent delayMs defaults to 3000");
  } finally {
    await close();
  }
});

test("receiptsPath round-trip: send writes JSONL receipts and a re-send skips already-sent rows — D-12", async () => {
  await withStubSmtp(async ({ port, logPath }) => {
    const { client, close } = await connect();
    const dir = mkdtempSync(join(tmpdir(), "cli-mcp-receipts-"));
    const receiptsPath = join(dir, "run.receipts.jsonl");
    const args = {
      csv: CSV,
      subject: "Hi {{name}}",
      body: "Code {{code}}",
      smtp: stubSmtpParam(port),
      from: "noreply@example.com",
      delayMs: 0,
      receiptsPath,
    };
    try {
      // First two-step send WITH a receiptsPath → 3 deliveries + 3 JSONL lines.
      const t1 = structured(await client.callTool({ name: "send", arguments: args })).confirmToken as string;
      const r1 = structured(await client.callTool({ name: "send", arguments: { ...args, confirmToken: t1 } }));
      assert.equal(r1.receiptsPath, receiptsPath, "the receiptsPath is echoed back");
      assert.equal(r1.receiptsWarning, undefined, "a supplied path carries no no-receipts warning");
      assert.equal(readRcptAddrs(logPath).length, 3, "first send delivered all rows");

      const lines = readFileSync(receiptsPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      assert.equal(lines.length, 3, "one JSONL receipt line per delivered row");

      // Second two-step send WITH THE SAME receiptsPath → resume skips all rows.
      const t2 = structured(await client.callTool({ name: "send", arguments: args })).confirmToken as string;
      await client.callTool({ name: "send", arguments: { ...args, confirmToken: t2 } });

      const addrs = readRcptAddrs(logPath);
      const counts = new Map<string, number>();
      for (const a of addrs) counts.set(a, (counts.get(a) ?? 0) + 1);
      assert.equal(addrs.length, 3, "the re-send added no deliveries (resume)");
      assert.ok([...counts.values()].every((n) => n === 1), "no address delivered twice");
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
