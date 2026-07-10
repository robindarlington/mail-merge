/**
 * lib/smtp/actions-core — the testable orchestration seams behind the Server
 * Actions in ./actions.ts. This module deliberately has NO "use server"
 * directive: in Next.js every runtime export of a "use server" module is
 * registered as a client-invocable endpoint, and these seams accept a caller
 * supplied `userId` / transport for test injection. Exporting them from the
 * action module would let a client bypass `auth()` and the verify rate limit
 * entirely (T-2-IDOR / AUTH-02). Here they are plain server-side functions:
 * importable by ./actions.ts and by tests, but never wire-callable.
 *
 * The "use server" wrappers in ./actions.ts are the ONLY public surface; each
 * re-derives `userId` via Clerk's `auth()` before delegating down to this file.
 */

import type { MailTransport } from "../core";
import { sendOne, verifyTransport } from "../core";
import { encrypt } from "../crypto";
import { upsertSmtpConfig } from "../data/smtp";
import { classifyVerifyError, type VerifyErrorField } from "./errors";
import { smtpFormSchema, type SmtpFormValues } from "./schema";
import { verifySmtp, type VerifyOutcome } from "./verify";

/**
 * The typed failure surface every action returns. It is intentionally a closed
 * union of message-only shapes — a `raw` field is ALWAYS a string, never the raw
 * Error object or the config (T-2-CRED / D-06). This is the contract 02-06 reads.
 */
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | {
      kind: "auth" | "connection" | "tls" | "unknown";
      field: VerifyErrorField;
      raw: string;
      suggestion?: "starttls" | "implicit";
    }
  | { kind: "rate_limited" }
  | { kind: "send_failed"; raw: string };

/** The uniform result every Server Action here resolves to (never rejects). */
export type ActionResult = { ok: true } | { ok: false; error: ActionError };

// --- Per-user verify rate limit (T-2-SPAM / Pitfall 9) ----------------------
// A user-supplied host:port dial is an abuse/SSRF surface; cap verify attempts
// per user in-process. Deliberately simple (a Map of recent timestamps) — a
// durable limiter is out of scope for v1's single-process web tier.
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_WINDOW_MS = 60_000;
const verifyAttempts = new Map<string, number[]>();

/**
 * Record a verify attempt and report whether the caller is still under the limit.
 * Returns true when the attempt is allowed, false when the window is saturated.
 */
export function underVerifyRateLimit(userId: string): boolean {
  const now = Date.now();
  const recent = (verifyAttempts.get(userId) ?? []).filter(
    (t) => now - t < VERIFY_WINDOW_MS,
  );
  if (recent.length >= VERIFY_MAX_ATTEMPTS) {
    verifyAttempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  verifyAttempts.set(userId, recent);
  return true;
}

/**
 * Orchestration seam (testable): parse → verify → persist. The `verifyFn` is
 * injectable so tests can drive verified_at semantics without a live SMTP dial.
 * The "use server" wrapper calls it with the real `verifySmtp`.
 *
 * Persists ONLY on a clean verify (D-04). A verify failure OR a D-05
 * alternate-mode `suggestion` returns WITHOUT saving (T-2-VERIFY): an unverified
 * or suggestion-only config never reaches the DB.
 */
export async function applyVerifiedConfig(
  userId: string,
  input: unknown,
  verifyFn: (values: SmtpFormValues) => Promise<VerifyOutcome> = verifySmtp,
): Promise<ActionResult> {
  const parsed = smtpFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  const outcome = await verifyFn(parsed.data);
  if (!outcome.ok) {
    // Whether it is a plain failure or a D-05 suggestion, nothing is saved.
    // Carry only the classified kind/field and a message-only `raw` (D-06).
    return {
      ok: false,
      error: {
        kind: outcome.kind,
        field: outcome.field,
        raw: outcome.raw,
        ...(outcome.suggestion ? { suggestion: outcome.suggestion } : {}),
      },
    };
  }

  // Verify succeeded — encrypt the password server-side and upsert (this is the
  // ONLY path that stamps verified_at, via upsertSmtpConfig).
  const { enc, iv, tag } = encrypt(parsed.data.password);
  await upsertSmtpConfig(userId, {
    host: parsed.data.host,
    port: parsed.data.port,
    secure: parsed.data.secure,
    username: parsed.data.username,
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: parsed.data.from_addr,
    from_name: parsed.data.from_name ?? null,
  });
  return { ok: true };
}

/**
 * Send seam (testable): verify-before-send over an INJECTED transport, then send
 * one message. Mirrors verifyAndSave's classification path — a failed pre-send
 * verify is classified with `classifyVerifyError` and returned WITHOUT calling
 * `sendOne`. Tests inject a stub transport to drive both branches without a
 * live SMTP dial. Returns message-only failures (no config, no password).
 */
export async function sendTestVia(
  config: { from_addr: string; from_name: string | null },
  toAddress: string,
  transport: MailTransport,
): Promise<ActionResult> {
  // Carry-forward CLAUDE.md constraint: verify() BEFORE any send. The saved
  // config could have gone stale / the network could be down since onboarding.
  try {
    await verifyTransport(transport);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const classified = classifyVerifyError(e);
    return {
      ok: false,
      error: {
        kind: classified.kind,
        field: classified.field,
        raw: e.message ?? String(err),
      },
    };
  }

  const from = config.from_name
    ? `${config.from_name} <${config.from_addr}>`
    : config.from_addr;

  const result = await sendOne({
    transport,
    from,
    to: toAddress,
    subject: "Mail Merge test email",
    body:
      "This is a test email from Mail Merge. If you received it, your SMTP " +
      "configuration is working and ready to send your merge.",
  });
  if (!result.ok) {
    // Map to a message-only send_failed — never the raw error object.
    return { ok: false, error: { kind: "send_failed", raw: result.error.message } };
  }
  return { ok: true };
}
