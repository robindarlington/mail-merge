/**
 * send — the SMTP send engine, lifted from the CLI's `send-credentials.ts`
 * (the createTransport + verify() + sendMail block, lines 129-144/146-171, and
 * the DELAY_MS throttle, line 24) into pure, reusable functions.
 *
 * Three carry-forward fixes / contracts land here:
 *   1. EXPLICIT `secure` boolean — the config supplies it directly; this module
 *      NEVER infers TLS from the port number (PITFALLS #3 / CONCERNS.md). The
 *      port-equals-implicit-TLS shortcut from the CLI is intentionally gone.
 *   2. Structured per-send result — `sendOne` returns { ok: true, messageId } or
 *      { ok: false, error } and NEVER throws-and-aborts, so the Phase 6 worker
 *      can catch-and-continue past one bad recipient (the CLI's per-row try/catch
 *      behaviour, surfaced as a value instead of a log line). This is the exact
 *      contract the worker consumes.
 *   3. Configurable throttle — DELAY_MS becomes a `throttle(ms)` parameter, not a
 *      magic constant.
 *
 * SECURITY (PITFALLS #2 / SMTP-04, security-critical): this module NEVER logs
 * the password, the auth object, or the full transport config. It does not log
 * at all — callers (the worker) log host/user/result through their own redacting
 * logger. The plan's automated grep gate enforces that no console or structured
 * logger call here references any secret field.
 *
 * PURITY: imports only nodemailer. No lib/db, no lib/crypto (the password
 * arrives ALREADY DECRYPTED from the caller), no Clerk, no Next.
 */

import nodemailer from "nodemailer";

/** SMTP connection config. `pass` arrives already-decrypted from the caller. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Explicit TLS mode — NOT inferred from the port (PITFALLS #3). */
  secure: boolean;
  auth: { user: string; pass: string };
  /**
   * Onboarding-only additive options (plan 02-02). All optional so existing
   * callers (the worker's send loop) are unaffected — omitted fields are not
   * passed to nodemailer, preserving the single-factory contract.
   */
  /** Force STARTTLS upgrade; set true when `secure:false` so a STARTTLS-capable
   *  server cannot silently keep the connection in cleartext (T-2-TLS). */
  requireTLS?: boolean;
  /** ms to wait for the TCP connection (nodemailer default 120_000). */
  connectionTimeout?: number;
  /** ms to wait for the SMTP greeting (nodemailer default 30_000). */
  greetingTimeout?: number;
  /** ms of socket inactivity before giving up (nodemailer default 600_000). */
  socketTimeout?: number;
  /** ms to wait for DNS resolution (nodemailer default 30_000). */
  dnsTimeout?: number;
}

/** Minimal duck-typed transport surface this module relies on. */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
  verify?(): Promise<unknown>;
}

export interface SendArgs {
  transport: MailTransport;
  from: string;
  to: string;
  subject: string;
  body: string;
}

/** Structured result of a single send — the contract the Phase 6 worker reads. */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: { message: string; code?: string } };

export const DEFAULT_DELAY_MS = 3000;

/**
 * Build a nodemailer transport from an explicit config. The `secure` boolean is
 * taken verbatim from `config` — there is NO port-based inference here.
 */
export function createSmtpTransport(config: SmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.auth.user, pass: config.auth.pass },
    // Additive onboarding options — only forwarded when the caller sets them,
    // so the worker's default transport is byte-for-byte unchanged.
    ...(config.requireTLS !== undefined && { requireTLS: config.requireTLS }),
    ...(config.connectionTimeout !== undefined && {
      connectionTimeout: config.connectionTimeout,
    }),
    ...(config.greetingTimeout !== undefined && {
      greetingTimeout: config.greetingTimeout,
    }),
    ...(config.socketTimeout !== undefined && {
      socketTimeout: config.socketTimeout,
    }),
    ...(config.dnsTimeout !== undefined && { dnsTimeout: config.dnsTimeout }),
  });
}

/**
 * Pre-send connectivity/auth gate — wraps `transport.verify()`. Lets a caller
 * fail fast before iterating recipients (the CLI's "SMTP connection OK" step).
 */
export async function verifyTransport(
  transport: Pick<MailTransport, "verify">,
): Promise<unknown> {
  if (typeof transport.verify !== "function") {
    throw new Error("transport does not support verify()");
  }
  return transport.verify();
}

/**
 * Send one message and map the outcome into a structured result. NEVER throws:
 * a rejected/throwing `sendMail` becomes { ok: false, error } so a batch can
 * continue (carries forward the CLI's per-row catch-and-continue).
 */
export async function sendOne(args: SendArgs): Promise<SendResult> {
  const { transport, from, to, subject, body } = args;
  try {
    const info = await transport.sendMail({ from, to, subject, text: body });
    return { ok: true, messageId: info.messageId ?? "" };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return {
      ok: false,
      error: {
        message: e?.message ?? String(err),
        ...(e?.code ? { code: e.code } : {}),
      },
    };
  }
}

/** Configurable inter-send delay (carry-forward of the CLI's DELAY_MS). */
export function throttle(ms: number = DEFAULT_DELAY_MS): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
