/**
 * scripts/stub-smtp — a throwaway local SMTP sink for the redeploy acceptance
 * test (SC-3 / T-08-12 / T-08-13).
 *
 * The redeploy acceptance harness needs to prove that an interrupted send resumes
 * with NO recipient double-sent. That guarantee is only observable at the wire:
 * this stub is an `smtp-server` SMTPServer that ACCEPTS ALL auth (so no real SMTP
 * credentials are ever used — T-08-13) and records EVERY `RCPT TO` address it
 * receives, with a timestamp, to a newline-delimited JSON log file. Because each
 * delivery appends exactly one line, a duplicate delivery is a duplicate line —
 * which the `scan` mode (and the acceptance harness `assert`) detect.
 *
 * The worker runs INSIDE the compose container and dials this sink on the HOST via
 * `host.docker.internal:<port>` (Docker Desktop 28.1.1). The seeded smtp_config is
 * `secure:false`; STARTTLS is disabled here and insecure auth is allowed so the
 * worker's plain nodemailer transport connects and delivers without a cert.
 *
 *   serve mode (default):  node --import tsx scripts/stub-smtp.ts serve --port 2525 --log /tmp/rcpt.jsonl
 *   scan mode:             node --import tsx scripts/stub-smtp.ts scan  --log /tmp/rcpt.jsonl
 *
 * The log is JSON LINES (one `{ "addr", "ts" }` object per line), NOT a single
 * JSON array — appends stay valid and atomic even across the interrupt/resume the
 * acceptance test drives. `scan` exits nonzero if ANY address appears more than
 * once (the duplicate-delivery detector).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { SMTPServer } from "smtp-server";

/** One recorded RCPT TO line. */
interface RcptEntry {
  addr: string;
  ts: string;
}

const DEFAULT_PORT = 2525;

/** Read `--flag value` / `--flag=value` style args into a simple map. */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

/** Resolve the RCPT log path from an explicit flag or the STUB_RCPT_LOG env. */
function resolveLogPath(flags: Record<string, string>): string {
  const p = flags.log ?? process.env.STUB_RCPT_LOG;
  if (!p) throw new Error("stub-smtp: --log <path> (or STUB_RCPT_LOG) is required");
  return p;
}

/** Parse the JSONL log into entries, tolerating a missing file (→ []). */
function readLog(path: string): RcptEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RcptEntry);
}

/**
 * `serve`: start the SMTP sink. Accepts every connection + AUTH, disables STARTTLS
 * (the seeded transport is `secure:false`), and appends one JSONL line per RCPT TO.
 */
function serve(flags: Record<string, string>): void {
  const port = Number(flags.port ?? process.env.STUB_SMTP_PORT ?? DEFAULT_PORT);
  const logPath = resolveLogPath(flags);

  const server = new SMTPServer({
    // No TLS/cert in a throwaway sink: disable STARTTLS so the worker's plain
    // transport never tries to upgrade, and allow AUTH over the cleartext socket.
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    // AUTH is accepted but not required, so nodemailer's verify() (EHLO + AUTH)
    // and its real sends both succeed without any credential mattering.
    authOptional: true,
    disableReverseLookup: true,
    logger: false,
    // Accept ANY credentials — no real SMTP password is ever validated (T-08-13).
    onAuth(_auth, _session, callback) {
      callback(null, { user: "stub" });
    },
    // Record EVERY RCPT TO exactly once — this append IS the duplicate detector.
    onRcptTo(address, _session, callback) {
      const entry: RcptEntry = {
        addr: address.address,
        ts: new Date().toISOString(),
      };
      appendFileSync(logPath, JSON.stringify(entry) + "\n");
      callback();
    },
    // Drain and accept the message body — we never store it (no user data at rest).
    onData(stream, _session, callback) {
      stream.on("data", () => {});
      stream.on("end", () => callback());
    },
  });

  server.on("error", (err) => {
    // Log the message only — never anything that could carry a credential.
    process.stderr.write(`stub-smtp server error: ${err.message}\n`);
  });

  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(
      `stub-smtp listening on 0.0.0.0:${port}, RCPT log → ${logPath}\n`,
    );
  });

  // Clean shutdown so the acceptance script's teardown is prompt.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

/**
 * `scan`: read the RCPT log and report duplicates. Exits nonzero if ANY address
 * was recorded more than once (a double-send), zero otherwise.
 */
function scan(flags: Record<string, string>): void {
  const logPath = resolveLogPath(flags);
  const entries = readLog(logPath);

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.addr, (counts.get(e.addr) ?? 0) + 1);

  const duplicates = [...counts.entries()].filter(([, n]) => n > 1);
  process.stdout.write(
    `stub-smtp scan: ${entries.length} RCPT(s), ${counts.size} unique address(es)\n`,
  );

  if (duplicates.length > 0) {
    for (const [addr, n] of duplicates) {
      process.stderr.write(`DUPLICATE: ${addr} delivered ${n} times\n`);
    }
    process.stderr.write(
      `FAIL: ${duplicates.length} address(es) double-sent\n`,
    );
    process.exit(1);
  }

  process.stdout.write("PASS: no duplicate deliveries\n");
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (mode) {
    case "serve":
    case undefined:
      serve(flags);
      break;
    case "scan":
      scan(flags);
      break;
    default:
      process.stderr.write(`stub-smtp: unknown mode '${mode}' (use serve|scan)\n`);
      process.exit(2);
  }
}

main();
