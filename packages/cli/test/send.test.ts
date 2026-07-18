/**
 * send.test — the live/test send slice (SC-1 / SC-2 / T-081-DUP / T-081-02).
 *
 * Layers:
 *  1. secrets.ts unit — env intake returns an EXPLICIT `secure`; a missing
 *     required var throws NAMING the var; the password never appears in a thrown
 *     message; the hidden-prompt fallback fires only when SMTP_PASS is unset.
 *  2. receipts.ts unit — path derivation, append+fsync round-trip through
 *     readSentSet, missing-file/blank-line tolerance; no secret field persisted.
 *  3. runSend integration — proven at the WIRE against scripts/stub-smtp (a real
 *     SMTPServer sink that appends one JSONL line per RCPT TO): live delivers one
 *     message per row; `--resume` re-runs with NO duplicate RCPT; and against a
 *     recording transport: test-mode addresses one address but keeps each row's
 *     real fill, and a known SMTP_PASS never reaches stdout/stderr or receipts.
 *
 * The runSend cases dynamically import ../src/run.js so this file's secrets/
 * receipts unit cases still run (and pass) before run.ts exists (Task 2 GREEN).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSmtpConfig } from "../src/secrets.js";
import { appendReceipt, deriveReceiptsPath, readSentSet } from "../src/receipts.js";
import type { MessageTemplate } from "../../../lib/core/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STUB = resolve(REPO_ROOT, "scripts/stub-smtp.ts");

const TEMPLATE: MessageTemplate = { subject: "Hi {{name}}", body: "Hello {{name}}, your code is {{code}}." };
const ROWS = [
  { email: "a@example.com", name: "Ada", code: "AAA" },
  { email: "b@example.com", name: "Bob", code: "BBB" },
  { email: "c@example.com", name: "Cy", code: "CCC" },
];

// A minimal recording transport matching lib/core.MailTransport — lets the fill
// and no-secret-leak cases inspect the exact messages runSend produced.
function recordingTransport() {
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  return {
    sent,
    transport: {
      async verify() {
        return true;
      },
      async sendMail(msg: { from: string; to: string; subject: string; text: string }) {
        sent.push(msg);
        return { messageId: `<stub-${sent.length}@local>` };
      },
      close() {},
    },
  };
}

/** Spawn scripts/stub-smtp serve, await readiness, run body, then tear it down. */
async function withStubSmtp(
  run: (opts: { port: number; logPath: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cli-stub-smtp-"));
  const logPath = join(dir, "rcpt.jsonl");
  const port = 20000 + (process.pid % 10000);
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

// --- secrets.ts --------------------------------------------------------------

test("readSmtpConfig maps env into an EXPLICIT-secure SmtpConfig", async () => {
  const intake = await readSmtpConfig({
    isTty: false,
    env: {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "onboard",
      SMTP_PASS: "s3cret",
      SMTP_SECURE: "false",
      FROM_ADDR: "noreply@example.com",
      FROM_NAME: "Example",
    } as NodeJS.ProcessEnv,
  });
  assert.equal(intake.smtp.host, "smtp.example.com");
  assert.equal(intake.smtp.port, 587);
  assert.equal(intake.smtp.secure, false, "secure comes from SMTP_SECURE, not the port");
  assert.equal(intake.smtp.auth.user, "onboard");
  assert.equal(intake.smtp.auth.pass, "s3cret");
  assert.equal(intake.from, "noreply@example.com");
  assert.equal(intake.fromName, "Example");
});

test("readSmtpConfig honours SMTP_SECURE=true explicitly (never inferred from port)", async () => {
  const intake = await readSmtpConfig({
    isTty: false,
    env: {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587", // a non-465 port with SMTP_SECURE=true must stay secure:true
      SMTP_USER: "u",
      SMTP_PASS: "p",
      SMTP_SECURE: "true",
      FROM_ADDR: "noreply@example.com",
    } as NodeJS.ProcessEnv,
  });
  assert.equal(intake.smtp.secure, true);
});

test("secure:false defaults requireTLS:true — the STARTTLS-stripping defense (CR-01)", async () => {
  const base = {
    SMTP_HOST: "h",
    SMTP_PORT: "587",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    SMTP_SECURE: "false",
    FROM_ADDR: "f@x.com",
  };

  const defaulted = await readSmtpConfig({ isTty: false, env: base as NodeJS.ProcessEnv });
  assert.equal(defaulted.smtp.requireTLS, true, "cleartext connections REQUIRE the STARTTLS upgrade by default");

  const optedOut = await readSmtpConfig({
    isTty: false,
    env: { ...base, SMTP_REQUIRE_TLS: "false" } as NodeJS.ProcessEnv,
  });
  assert.equal(optedOut.smtp.requireTLS, false, "SMTP_REQUIRE_TLS=false is an explicit opt-out");

  const secure = await readSmtpConfig({
    isTty: false,
    env: { ...base, SMTP_SECURE: "true" } as NodeJS.ProcessEnv,
  });
  assert.equal(secure.smtp.requireTLS, undefined, "implicit-TLS connections do not set requireTLS at all");
});

test("readSmtpConfig throws NAMING the missing var, never leaking a value", async () => {
  await assert.rejects(
    () =>
      readSmtpConfig({
        isTty: false,
        env: { SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", FROM_ADDR: "f@x.com" } as NodeJS.ProcessEnv,
      }),
    (e: Error) => e.message.includes("SMTP_HOST") && !e.message.includes("587"),
  );
});

test("a thrown intake error never contains the password value (SC-2)", async () => {
  // Missing FROM_ADDR while a password IS present in env: the error must not echo it.
  await assert.rejects(
    () =>
      readSmtpConfig({
        isTty: false,
        env: {
          SMTP_HOST: "h",
          SMTP_PORT: "587",
          SMTP_USER: "u",
          SMTP_PASS: "TOP-SECRET-PW",
        } as NodeJS.ProcessEnv,
      }),
    (e: Error) => e.message.includes("FROM_ADDR") && !e.message.includes("TOP-SECRET-PW"),
  );
});

test("readSmtpConfig falls back to the hidden prompt only when SMTP_PASS is unset + TTY", async () => {
  let prompted = false;
  const intake = await readSmtpConfig({
    isTty: true,
    prompt: async () => {
      prompted = true;
      return "typed-pw";
    },
    env: {
      SMTP_HOST: "h",
      SMTP_PORT: "587",
      SMTP_USER: "u",
      FROM_ADDR: "f@x.com",
    } as NodeJS.ProcessEnv,
  });
  assert.equal(prompted, true, "the hidden prompt was used");
  assert.equal(intake.smtp.auth.pass, "typed-pw");
});

test("no TTY + no SMTP_PASS throws (no silent empty password)", async () => {
  await assert.rejects(
    () =>
      readSmtpConfig({
        isTty: false,
        env: { SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", FROM_ADDR: "f@x.com" } as NodeJS.ProcessEnv,
      }),
    /No SMTP password provided/,
  );
});

// --- receipts.ts -------------------------------------------------------------

test("deriveReceiptsPath swaps the CSV extension to .receipts.jsonl", () => {
  assert.equal(deriveReceiptsPath("mydata.csv"), "mydata.receipts.jsonl");
  assert.equal(deriveReceiptsPath("/tmp/run/list.csv"), join("/tmp/run", "list.receipts.jsonl"));
});

test("appendReceipt + readSentSet round-trip; only 'sent' addresses are returned", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-receipts-"));
  const path = join(dir, "out.receipts.jsonl");
  try {
    appendReceipt(path, { to: "a@x.com", status: "sent", messageId: "<1>", timestamp: "t1" });
    appendReceipt(path, { to: "b@x.com", status: "failed", error: "bounced", timestamp: "t2" });
    appendReceipt(path, { to: "c@x.com", status: "sent", messageId: "<3>", timestamp: "t3" });

    const set = readSentSet(path);
    assert.deepEqual([...set].sort(), ["a@x.com", "c@x.com"]);
    assert.equal(set.has("b@x.com"), false, "a failed row is NOT in the resume set");

    // No secret field ever lands in a receipt line.
    const raw = readFileSync(path, "utf8");
    assert.ok(!/pass/i.test(raw), "no password field in the receipts file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSentSet tolerates a missing file (empty set) and blank/trailing lines", () => {
  assert.deepEqual([...readSentSet(join(tmpdir(), "does-not-exist-xyz.jsonl"))], []);

  const dir = mkdtempSync(join(tmpdir(), "cli-receipts-blank-"));
  const path = join(dir, "r.jsonl");
  try {
    writeFileSync(
      path,
      `\n${JSON.stringify({ to: "a@x.com", status: "sent", timestamp: "t" })}\n\n`,
    );
    assert.deepEqual([...readSentSet(path)], ["a@x.com"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSentSet tolerates a TORN final line from an interrupted append (WR-02)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-receipts-torn-"));
  const path = join(dir, "r.jsonl");
  try {
    // A complete 'sent' line, then a truncated one — the crash-window artifact.
    writeFileSync(
      path,
      `${JSON.stringify({ to: "a@x.com", status: "sent", timestamp: "t" })}\n{"to":"b@x.com","sta`,
    );
    const set = readSentSet(path);
    assert.deepEqual([...set], ["a@x.com"], "the intact line is kept, the torn line is skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runSend integration (GREEN in Task 2) -----------------------------------

test("runSend live delivers exactly one RCPT per row over stub-smtp", async () => {
  const { runSend } = await import("../src/run.js");
  await withStubSmtp(async ({ port, logPath }) => {
    const dir = mkdtempSync(join(tmpdir(), "cli-live-"));
    const receiptsPath = join(dir, "run.receipts.jsonl");
    try {
      await runSend({
        mode: "live",
        rows: ROWS,
        emailColumn: "email",
        template: TEMPLATE,
        smtp: { host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" } },
        from: "noreply@example.com",
        delayMs: 0,
        receiptsPath,
      });

      const addrs = readRcptAddrs(logPath);
      assert.deepEqual(addrs.sort(), ["a@example.com", "b@example.com", "c@example.com"]);

      const set = readSentSet(receiptsPath);
      assert.equal(set.size, 3, "one 'sent' receipt per delivered row");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("runSend --resume re-runs with NO duplicate RCPT in the stub log", async () => {
  const { runSend } = await import("../src/run.js");
  await withStubSmtp(async ({ port, logPath }) => {
    const dir = mkdtempSync(join(tmpdir(), "cli-resume-"));
    const receiptsPath = join(dir, "run.receipts.jsonl");
    const smtp = { host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" } };
    try {
      // First full run: 3 deliveries recorded.
      await runSend({ mode: "live", rows: ROWS, emailColumn: "email", template: TEMPLATE, smtp, from: "f@x.com", delayMs: 0, receiptsPath });
      assert.equal(readRcptAddrs(logPath).length, 3, "first run delivered all rows");

      // Resume: readSentSet has all three → every row is skipped, no new RCPT.
      await runSend({ mode: "live", rows: ROWS, emailColumn: "email", template: TEMPLATE, smtp, from: "f@x.com", delayMs: 0, receiptsPath, resume: true });

      const addrs = readRcptAddrs(logPath);
      const counts = new Map<string, number>();
      for (const a of addrs) counts.set(a, (counts.get(a) ?? 0) + 1);
      assert.equal(addrs.length, 3, "resume added no deliveries");
      assert.ok([...counts.values()].every((n) => n === 1), "no address delivered twice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("runSend test mode addresses ONE address but keeps each row's real fill (CLI --test parity)", async () => {
  const { runSend } = await import("../src/run.js");
  const { transport, sent } = recordingTransport();
  const dir = mkdtempSync(join(tmpdir(), "cli-testmode-"));
  const receiptsPath = join(dir, "t.receipts.jsonl");
  try {
    await runSend({
      mode: "test",
      testAddr: "proof@me.com",
      rows: ROWS,
      emailColumn: "email",
      template: TEMPLATE,
      smtp: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" } },
      from: "noreply@example.com",
      delayMs: 0,
      receiptsPath,
      createTransport: () => transport,
    });

    assert.equal(sent.length, 3, "one message per row");
    assert.ok(sent.every((m) => m.to === "proof@me.com"), "every message went to the single test address");
    assert.deepEqual(
      sent.map((m) => m.subject),
      ["Hi Ada", "Hi Bob", "Hi Cy"],
      "each message keeps that row's REAL per-row subject fill",
    );
    assert.match(sent[0].text, /code is AAA/);
    assert.match(sent[2].text, /code is CCC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test mode + resume is rejected — resume keyed on the test address would skip every row (WR-03)", async () => {
  const { runSend } = await import("../src/run.js");
  const { transport } = recordingTransport();
  await assert.rejects(
    () =>
      runSend({
        mode: "test",
        testAddr: "proof@me.com",
        rows: ROWS,
        emailColumn: "email",
        template: TEMPLATE,
        smtp: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" } },
        from: "noreply@example.com",
        delayMs: 0,
        receiptsPath: join(tmpdir(), "never-written.receipts.jsonl"),
        resume: true,
        createTransport: () => transport,
      }),
    /--resume cannot be combined with --test/,
  );
});

test("an injected log sink receives ALL progress; console.log is never touched (WR-01)", async () => {
  const { runSend } = await import("../src/run.js");
  const { transport } = recordingTransport();
  const sink: string[] = [];

  let consoleLogCalls = 0;
  const origLog = console.log;
  console.log = () => {
    consoleLogCalls++;
  };
  try {
    await runSend({
      mode: "test",
      testAddr: "proof@me.com",
      rows: ROWS,
      emailColumn: "email",
      template: TEMPLATE,
      smtp: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" } },
      from: "noreply@example.com",
      delayMs: 0,
      noReceipts: true,
      createTransport: () => transport,
      log: (l) => sink.push(l),
    });
  } finally {
    console.log = origLog;
  }

  assert.equal(consoleLogCalls, 0, "with a log sink injected, console.log is NEVER called");
  assert.ok(sink.some((l) => l.includes("sent -> proof@me.com")), "per-row progress reached the sink");
  assert.ok(sink.some((l) => l.includes("Done.")), "the summary line reached the sink");
});

test("a known SMTP_PASS never reaches stdout/stderr or the receipts file (SC-2)", async () => {
  const { runSend } = await import("../src/run.js");
  const SECRET = "MARKER-PW-do-not-leak-42";
  const { transport } = recordingTransport();
  const dir = mkdtempSync(join(tmpdir(), "cli-nopwleak-"));
  const receiptsPath = join(dir, "leak.receipts.jsonl");

  const captured: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => captured.push(a.join(" "));
  console.error = (...a: unknown[]) => captured.push(a.join(" "));
  try {
    await runSend({
      mode: "live",
      rows: ROWS,
      emailColumn: "email",
      template: TEMPLATE,
      smtp: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: SECRET } },
      from: "noreply@example.com",
      delayMs: 0,
      receiptsPath,
      createTransport: () => transport,
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const out = captured.join("\n");
  assert.ok(!out.includes(SECRET), "the password never appears in captured stdout/stderr");
  const receipts = existsSync(receiptsPath) ? readFileSync(receiptsPath, "utf8") : "";
  assert.ok(!receipts.includes(SECRET), "the password never appears in the receipts file");
});
