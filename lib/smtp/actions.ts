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
 *  - T-2-IDOR / AUTH-02: every runtime export of a "use server" module is a
 *    client-invocable endpoint, so this file exports ONLY the three actions
 *    above — each re-derives `userId` server-side via `auth()` and passes it to
 *    the userId-scoped DAL; a client-supplied id is never trusted. The testable
 *    seams that accept `userId`/transport parameters live in ./actions-core.ts
 *    (no "use server"), where they are imports, not endpoints.
 *  - T-2-CRED / SMTP-04 / D-06: no action return ever carries the password or a raw
 *    nodemailer Error object. A classified failure carries only a message STRING in
 *    `raw`. Nothing secret is logged (grep-enforced).
 *  - T-2-SPAM: verifyAndSave applies a lightweight per-user in-process rate limit on
 *    verify attempts (Pitfall 9), bounding the SSRF/abuse surface of a user-supplied
 *    host:port dial.
 */

import type { MailTransport } from "../core";
import { createSmtpTransport } from "../core";
import { decrypt } from "../crypto";
import {
  getSmtpConfigForUser,
  updateFromFields as dalUpdateFromFields,
} from "../data/smtp";
import {
  applyVerifiedConfig,
  sendTestVia,
  underVerifyRateLimit,
  type ActionResult,
} from "./actions-core";
import { smtpFormSchema } from "./schema";
import { verifySmtp } from "./verify";

// Type-only re-exports are erased at compile time, so they are NOT registered
// as server actions — the wizard (02-06) imports its contract from here.
export type { ActionError, ActionResult } from "./actions-core";

/**
 * verifyAndSave (SMTP-05 / D-04): auth → rate-limit → verify-then-save. Rejects
 * unauthenticated callers and callers over the per-user verify budget before any
 * dial. Delegates parse → verifySmtp → encrypt + upsertSmtpConfig to
 * `applyVerifiedConfig` (actions-core), passing the real verify engine
 * explicitly at this trust boundary.
 */
export async function verifyAndSave(raw: unknown): Promise<ActionResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  if (!underVerifyRateLimit(userId)) {
    return { ok: false, error: { kind: "rate_limited" } };
  }
  return applyVerifiedConfig(userId, raw, verifySmtp);
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
