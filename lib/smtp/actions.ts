"use server";

/**
 * lib/smtp/actions — the three Server Actions behind the onboarding wizard and
 * the edit flow (SMTP-05 / AUTH-02 / SMTP-04). This is the seam that ties Clerk
 * identity, the verify engine (02-02), the userId-scoped DAL (02-03), and the
 * credential crypto together, and it defines the typed `ActionResult` contract
 * the wizard UI (02-06) consumes.
 *
 *   verifyAndSave   — verify-then-save as ONE atomic action (D-04). A verify
 *                     failure (or a D-05 alternate-mode suggestion) saves NOTHING;
 *                     only a clean verify persists the encrypted config and stamps
 *                     verified_at.
 *   updateFromFields — saves from_addr / from_name WITHOUT a verify round-trip and
 *                     WITHOUT touching verified_at (D-08 / Pitfall 6): changing the
 *                     display name/address does not invalidate a proven connection.
 *   sendTestEmail   — reuses lib/core/send.ts to prove the SAVED transport really
 *                     delivers. Carries forward the CLAUDE.md constraint of running
 *                     `transport.verify()` BEFORE any send.
 *
 * SECURITY:
 *  - T-2-IDOR / AUTH-02: every action re-derives `userId` server-side via `auth()`
 *    and passes it to the userId-scoped DAL — a client-supplied id is never trusted
 *    (defense in depth behind the DAL's own scoping).
 *  - T-2-CRED / SMTP-04 / D-06: no action return ever carries the password or a raw
 *    nodemailer Error object. A classified failure carries only a message STRING in
 *    `raw`. Nothing secret is logged (grep-enforced).
 *  - T-2-SPAM: verifyAndSave applies a lightweight per-user in-process rate limit on
 *    verify attempts (Pitfall 9), bounding the SSRF/abuse surface of a user-supplied
 *    host:port dial.
 */

import type { MailTransport } from "../core";
import { createSmtpTransport, sendOne, verifyTransport } from "../core";
import { decrypt, encrypt } from "../crypto";
import {
  getSmtpConfigForUser,
  updateFromFields as dalUpdateFromFields,
  upsertSmtpConfig,
} from "../data/smtp";
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
function underVerifyRateLimit(userId: string): boolean {
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
 * Non-action orchestration seam (testable): parse → verify → persist. The
 * `verifyFn` is injectable so tests can drive verified_at semantics without a
 * live SMTP dial. The "use server" wrappers call it with the real `verifySmtp`.
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
 * verifyAndSave (SMTP-05 / D-04): auth → rate-limit → verify-then-save. Rejects
 * unauthenticated callers and callers over the per-user verify budget before any
 * dial. Delegates the parse/verify/persist to `applyVerifiedConfig`.
 */
export async function verifyAndSave(raw: unknown): Promise<ActionResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner (the seams are what tests drive).
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  if (!underVerifyRateLimit(userId)) {
    return { ok: false, error: { kind: "rate_limited" } };
  }
  return applyVerifiedConfig(userId, raw);
}

/**
 * updateFromFields (D-08): save ONLY the sender-identity fields. Deliberately does
 * NOT call `verifySmtp` and does NOT write `verified_at` — a display-name/address
 * edit does not invalidate a proven connection (Pitfall 6). The DAL's
 * updateFromFields leaves verified_at untouched.
 */
export async function updateFromFields(raw: unknown): Promise<ActionResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  // Parse ONLY the from-fields — a subset of the shared schema so the same
  // validation (valid email, trimmed name) can never diverge.
  const fromSchema = smtpFormSchema.pick({ from_addr: true, from_name: true });
  const parsed = fromSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  await dalUpdateFromFields(userId, {
    from_addr: parsed.data.from_addr,
    from_name: parsed.data.from_name ?? null,
  });
  return { ok: true };
}

/**
 * Non-action send seam (testable): verify-before-send over an INJECTED transport,
 * then send one message. Mirrors verifyAndSave's classification path — a failed
 * pre-send verify is classified with `classifyVerifyError` and returned WITHOUT
 * calling `sendOne`. Tests inject a stub transport to drive both branches without
 * a live SMTP dial. Returns message-only failures (no config, no password).
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

/**
 * sendTestEmail (SMTP-05 / D-03): auth → load the saved config → decrypt the
 * password SERVER-SIDE ONLY → build the transport → verify-before-send → send one
 * real message to `toAddress` (defaulting to the Clerk primary email, Open
 * Question 1). Persists NOTHING (the config is already saved+verified). Always
 * closes the transport, even on a hung verify.
 */
export async function sendTestEmail(toAddress?: string): Promise<ActionResult> {
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const row = await getSmtpConfigForUser(userId);
  if (!row) {
    return {
      ok: false,
      error: { kind: "unknown", field: "form", raw: "No SMTP configuration saved." },
    };
  }

  // Default the recipient to the caller's own primary email (Open Question 1).
  let to = toAddress;
  if (!to) {
    const user = await currentUser();
    to =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress;
  }
  if (!to) {
    return {
      ok: false,
      error: { kind: "unknown", field: "form", raw: "No recipient address available." },
    };
  }

  // Decrypt the AES-256-GCM triple server-side only — the plaintext exists
  // transiently in memory at send time and is never returned or logged.
  const password = decrypt({
    enc: row.password_enc as Buffer,
    iv: row.password_iv as Buffer,
    tag: row.password_tag as Buffer,
  });

  const transport = createSmtpTransport({
    host: row.host,
    port: row.port,
    secure: row.secure,
    auth: { user: row.username, pass: password },
  });
  try {
    return await sendTestVia(
      { from_addr: row.from_addr, from_name: row.from_name },
      to,
      transport as unknown as MailTransport,
    );
  } finally {
    // Never leave the socket dangling, even on a thrown/hung verify.
    transport.close();
  }
}
