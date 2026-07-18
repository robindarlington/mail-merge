/**
 * secrets — env-first SMTP intake + the no-echo password prompt (SC-2 / T-081-01).
 *
 * The SMTP password enters the process through EXACTLY two channels: the
 * `SMTP_PASS` environment variable, or a hidden (no-echo) terminal prompt. It is
 * NEVER read from argv (the arg contract in args.ts structurally omits any
 * password flag) and NEVER logged. Every missing-required-var error names the
 * VARIABLE only — never a value — so a stack trace can never carry a secret.
 *
 * Explicit TLS (T-081-TLS / carry-forward fix): `secure` comes from `SMTP_SECURE`
 * ("true"/"false"), NEVER inferred from the port number. `send-credentials.ts`
 * used `secure: port === 465`; that port-based inference is intentionally gone.
 *
 * STARTTLS-stripping defense (T-2-TLS): when `secure` is false the config sets
 * `requireTLS: true` by DEFAULT, so a STARTTLS-capable server (or an active MITM
 * stripping the upgrade) can never silently keep AUTH on a cleartext connection.
 * `SMTP_REQUIRE_TLS=false` is the explicit opt-out for genuinely plaintext-only
 * local relays.
 *
 * `promptHidden` is ported verbatim from `send-credentials.ts` (the readline
 * `_writeToOutput` mute trick), so the interactive experience is byte-identical.
 */

import readline from "node:readline";

import type { SmtpConfig } from "../../../lib/core/index.js";

/** Result of {@link readSmtpConfig}: a ready SmtpConfig plus the From identity. */
export interface SmtpIntake {
  smtp: SmtpConfig;
  from: string;
  fromName?: string;
}

/** Injectable seams so tests drive intake without a real TTY (all optional). */
export interface ReadSmtpConfigOpts {
  /** Environment source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Hidden-prompt function (defaults to {@link promptHidden}); stubbed in tests. */
  prompt?: (query: string) => Promise<string>;
  /** Whether an interactive TTY is attached (defaults to `process.stdin.isTTY`). */
  isTty?: boolean;
}

/**
 * Ask a question on the terminal WITHOUT echoing the typed characters. Ported
 * verbatim from send-credentials.ts::promptHidden — the readline `_writeToOutput`
 * override mutes everything typed after the prompt is shown.
 */
export function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const anyRl = rl as unknown as {
      _writeToOutput: (s: string) => void;
      output: NodeJS.WriteStream;
    };
    let muted = false;
    anyRl._writeToOutput = (s) => {
      if (!muted) anyRl.output.write(s);
    };
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true; // hide everything typed after the prompt is shown
  });
}

/** Read a required env var; throw NAMING THE VAR (never a value) if absent/empty. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env var ${name} (set it in your environment or .env).`);
  return v;
}

/**
 * Assemble an {@link SmtpIntake} from the environment. Required vars:
 * `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `FROM_ADDR`. `SMTP_SECURE` is read as an
 * EXPLICIT boolean (default `false`) — never inferred from the port. When
 * `secure` is false, `requireTLS` defaults to true (STARTTLS upgrade REQUIRED,
 * T-2-TLS) unless `SMTP_REQUIRE_TLS=false` explicitly opts out. The password
 * comes from `SMTP_PASS`; if that is unset and a TTY is attached, it falls back to
 * the hidden prompt. A still-empty password throws "No SMTP password provided."
 *
 * The returned object's `auth.pass` is NEVER included in any thrown message and is
 * never logged by this module.
 */
export async function readSmtpConfig(opts: ReadSmtpConfigOpts = {}): Promise<SmtpIntake> {
  const env = opts.env ?? process.env;
  const prompt = opts.prompt ?? promptHidden;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);

  const host = requireEnv(env, "SMTP_HOST");
  const user = requireEnv(env, "SMTP_USER");
  const from = requireEnv(env, "FROM_ADDR");

  const rawPort = requireEnv(env, "SMTP_PORT");
  const port = Number(rawPort);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("SMTP_PORT must be a positive port number");
  }

  // EXPLICIT TLS — read from SMTP_SECURE, never derived from the port (T-081-TLS).
  const secure = (env.SMTP_SECURE ?? "").trim().toLowerCase() === "true";

  // Password: env first, hidden prompt fallback only when interactive, never argv.
  let pass = env.SMTP_PASS;
  if (!pass && isTty) {
    pass = await prompt(`SMTP password for ${user} (input hidden): `);
  }
  if (!pass) throw new Error("No SMTP password provided.");

  const fromName = env.FROM_NAME || undefined;

  // STARTTLS-stripping defense (T-2-TLS): on a cleartext connection, REQUIRE the
  // STARTTLS upgrade unless SMTP_REQUIRE_TLS=false explicitly opts out (needed
  // only for genuinely plaintext-only local relays). Irrelevant when secure:true.
  const requireTLS = (env.SMTP_REQUIRE_TLS ?? "true").trim().toLowerCase() === "true";

  const smtp: SmtpConfig = {
    host,
    port,
    secure,
    auth: { user, pass },
    ...(secure ? {} : { requireTLS }),
  };

  return { smtp, from, ...(fromName ? { fromName } : {}) };
}
