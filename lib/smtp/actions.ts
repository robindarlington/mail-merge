"use server";

/**
 * lib/smtp/actions — the Server Actions behind the multi-server settings surface
 * and the onboarding/edit flow (SMTP-05 / AUTH-02 / SMTP-04 / 06.1 MSMTP-01/05).
 * This is the seam that ties Clerk identity, the verify engine (02-02), the
 * id-scoped multi-server DAL (06.1-01), and the credential crypto together, and it
 * defines the typed `ActionResult` contract the settings UI (06.1-03/04) consumes.
 *
 *   createServer     — verify-then-INSERT a NEW named server as ONE atomic action
 *                      (D-04). A verify failure (or a D-05 suggestion) saves
 *                      NOTHING; only a clean verify persists the encrypted config,
 *                      stamps verified_at, and auto-defaults the first server.
 *   updateServer     — verify-then-UPDATE an owned server BY ID. WR-09 (LOCKED):
 *                      a blank password is only kept when the host is unchanged.
 *   setDefaultServer — make one owned server the account default (owner-scoped).
 *   deleteServer     — soft-delete one owned server, blocked by the in-use guard
 *                      when a queued/running campaign still references it (SC5).
 *   updateFromFields — saves from_addr / from_name WITHOUT a verify round-trip and
 *                      WITHOUT touching verified_at (D-08 / Pitfall 6).
 *   sendTestEmail    — reuses lib/core/send.ts to prove a SAVED, id-addressed
 *                      transport really delivers. Carries forward the CLAUDE.md
 *                      constraint of running `transport.verify()` BEFORE any send.
 *
 * SECURITY:
 *  - T-061-06 IDOR / AUTH-02: every runtime export of a "use server" module is a
 *    client-invocable endpoint, so this file exports ONLY the actions above — each
 *    re-derives `userId` server-side via `auth()` and resolves any client-supplied
 *    id through the owner-scoped DAL; a client id is a proposal, never an owner
 *    claim. The testable seams that accept `userId`/transport parameters live in
 *    ./actions-core.ts (no "use server"), where they are imports, not endpoints.
 *  - T-061-05 WR-09 / SMTP-04 / D-06: no action return ever carries the password or
 *    a raw nodemailer Error object. A classified failure carries only a message
 *    STRING in `raw`. Nothing secret is logged (grep-enforced).
 *  - T-061-08 / T-2-SPAM: create/update apply a lightweight per-user in-process
 *    rate limit on verify attempts (Pitfall 9), bounding the SSRF/abuse surface of
 *    a user-supplied host:port dial.
 */

import { z } from "zod";

import type { MailTransport } from "../core";
import { createSmtpTransport } from "../core";
import { decrypt } from "../crypto";
import {
  getSmtpConfigByIdForUser,
  updateFromFields as dalUpdateFromFields,
} from "../data/smtp";
import {
  applyVerifiedConfig,
  sendTestVia,
  setDefaultConfigCore,
  softDeleteConfigCore,
  underVerifyRateLimit,
  type ActionResult,
} from "./actions-core";
import { smtpFormSchema } from "./schema";
import { verifySmtp } from "./verify";

// Type-only re-exports are erased at compile time, so they are NOT registered
// as server actions — the settings UI imports its contract from here.
export type { ActionError, ActionResult } from "./actions-core";

// The FormData/string → number coercion for a config id (mirrors campaignIdSchema).
// Rejects "0" / "-1" / non-numeric so a malformed id never reaches the DAL. Kept
// module-private (not exported) so it is not registered as a server action.
const smtpConfigIdSchema = z.coerce.number().int().positive();

/** Parse an untrusted id; a validation failure short-circuits the action. */
function parseId(
  id: unknown,
): { ok: true; id: number } | { ok: false; result: ActionResult } {
  const parsed = smtpConfigIdSchema.safeParse(id);
  if (!parsed.success) {
    return {
      ok: false,
      result: {
        ok: false,
        error: { kind: "validation", issues: parsed.error.issues },
      },
    };
  }
  return { ok: true, id: parsed.data };
}

/**
 * createServer (MSMTP-01 / SMTP-05 / D-04): auth → rate-limit → verify-then-INSERT.
 * Rejects unauthenticated callers and callers over the per-user verify budget
 * before any dial. Delegates parse → verifySmtp → encrypt + createSmtpConfig to
 * `applyVerifiedConfig(userId, null, ...)` (id === null = the create flow),
 * passing the real verify engine explicitly at this trust boundary.
 */
export async function createServer(raw: unknown): Promise<ActionResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  if (!underVerifyRateLimit(userId)) {
    return { ok: false, error: { kind: "rate_limited" } };
  }
  return applyVerifiedConfig(userId, null, raw, verifySmtp);
}

/**
 * updateServer (MSMTP-01 / SMTP-05 / WR-09): auth → validate id → rate-limit →
 * verify-then-UPDATE the owned row by id. The id is validated but never trusted as
 * an owner claim — `applyVerifiedConfig` re-resolves it through the owner-scoped
 * DAL, and WR-09 (LOCKED) rejects a blank password when the host changed.
 */
export async function updateServer(
  id: unknown,
  raw: unknown,
): Promise<ActionResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsedId = parseId(id);
  if (!parsedId.ok) return parsedId.result;

  if (!underVerifyRateLimit(userId)) {
    return { ok: false, error: { kind: "rate_limited" } };
  }
  return applyVerifiedConfig(userId, parsedId.id, raw, verifySmtp);
}

/**
 * setDefaultServer (MSMTP-05): auth → validate id → make the owned server the
 * account default. A cross-tenant / deleted / unknown id resolves to `not_found`
 * inside the core seam (T-061-06 IDOR).
 */
export async function setDefaultServer(id: unknown): Promise<ActionResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsedId = parseId(id);
  if (!parsedId.ok) return parsedId.result;

  return setDefaultConfigCore(userId, parsedId.id);
}

/**
 * deleteServer (MSMTP-05 / SC5): auth → validate id → soft-delete the owned server,
 * refused with `in_use` when a queued/running campaign still references it. A
 * cross-tenant / already-deleted / unknown id resolves to `not_found`.
 */
export async function deleteServer(id: unknown): Promise<ActionResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsedId = parseId(id);
  if (!parsedId.ok) return parsedId.result;

  return softDeleteConfigCore(userId, parsedId.id);
}

/**
 * updateFromFields (D-08): save ONLY the sender-identity fields. Deliberately does
 * NOT call `verifySmtp` and does NOT write `verified_at` — a display-name/address
 * edit does not invalidate a proven connection (Pitfall 6). The DAL's
 * updateFromFields leaves verified_at untouched. (Stays userId-scoped for the
 * sender-only edit; the wizard's per-row connection edits go through updateServer.)
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
 * sendTestEmail (MSMTP / SMTP-05 / D-03): auth → validate id → load the OWNED,
 * id-addressed config → decrypt the password SERVER-SIDE ONLY → build the transport
 * → verify-before-send → send one real message to `toAddress` (defaulting to the
 * Clerk primary email, Open Question 1). Persists NOTHING (the config is already
 * saved+verified). Always closes the transport, even on a hung verify. A
 * cross-tenant / deleted / unknown id resolves to `not_found` (T-061-06).
 */
export async function sendTestEmail(
  id: unknown,
  toAddress?: string,
): Promise<ActionResult> {
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsedId = parseId(id);
  if (!parsedId.ok) return parsedId.result;

  const row = await getSmtpConfigByIdForUser(userId, parsedId.id);
  if (!row) {
    return { ok: false, error: { kind: "not_found" } };
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
