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
import { decrypt, encrypt } from "../crypto";
import {
  countActiveSendsForConfig,
  createSmtpConfig,
  getSmtpConfigByIdForUser,
  listSmtpConfigsForUser,
  setDefaultSmtpConfig,
  softDeleteSmtpConfig,
  updateSmtpConfigById,
  updateSmtpConfigMeta,
} from "../data/smtp";
import { classifyVerifyError, type VerifyErrorField } from "./errors";
import {
  smtpEditFormSchema,
  smtpMetaFormSchema,
  type SmtpFormValues,
} from "./schema";
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
  | { kind: "send_failed"; raw: string }
  // 06.1 multi-server: an owned id resolved to no row (cross-tenant / deleted /
  // unknown), and a soft-delete refused because a queued/running campaign still
  // references the config (the in-use guard, SC5).
  | { kind: "not_found" }
  | { kind: "in_use" };

/** The uniform result every Server Action here resolves to (never rejects). */
export type ActionResult =
  | { ok: true; id?: number }
  | { ok: false; error: ActionError };

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

/** A `path`-anchored zod-style custom validation issue helper (message-only). */
function validationError(path: string, message: string): ActionResult {
  return {
    ok: false,
    error: {
      kind: "validation",
      issues: [{ code: "custom", path: [path], message }],
    },
  };
}

/**
 * Orchestration seam (testable): parse → (label-unique) → verify → persist. The
 * `verifyFn` is injectable so tests can drive verified_at semantics without a
 * live SMTP dial. The "use server" wrappers call it with the real `verifySmtp`.
 *
 * `id === null` is the CREATE flow (insert a new named server); a number is the
 * EDIT flow (update that owned row by id). Persists ONLY on a clean verify (D-04):
 * a verify failure OR a D-05 alternate-mode `suggestion` returns WITHOUT saving
 * (T-2-VERIFY) — an unverified or suggestion-only config never reaches the DB.
 *
 * WR-09 (LOCKED, option 2): on an EDIT with a blank ("keep") password, the stored
 * credential is merged in ONLY when the host is unchanged. A changed host with a
 * blank password is REJECTED before any decrypt — the stored secret is never
 * re-authed against a client-changed host (T-061-05 information-disclosure gate).
 */
export async function applyVerifiedConfig(
  userId: string,
  id: number | null,
  input: unknown,
  verifyFn: (values: SmtpFormValues) => Promise<VerifyOutcome> = verifySmtp,
): Promise<ActionResult> {
  // Parse with the EDIT schema (blank password allowed): a blank is the D-07
  // "leave blank to keep" signal, resolved server-side below. The create flow's
  // "password required" rule is re-imposed by the id === null branch.
  const parsed = smtpEditFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  // Label uniqueness (LOCKED — required, case-insensitively UNIQUE per account).
  // An application check (not a LOWER(label) expression unique index) is sufficient
  // here: better-sqlite3 is single-writer, so the TOCTOU window between this read
  // and the persist below is negligible for this solo-tenant tool, and it avoids a
  // migration for an expression index. Compare trimmed + lower-cased, EXCLUDING the
  // row being edited (by id) so an unchanged label on edit is not a self-conflict.
  const existingConfigs = await listSmtpConfigsForUser(userId);
  const wantedLabel = parsed.data.label.trim().toLowerCase();
  const labelClash = existingConfigs.some(
    (c) =>
      c.id !== id && (c.label ?? "").trim().toLowerCase() === wantedLabel,
  );
  if (labelClash) {
    return validationError(
      "label",
      `You already have a server called '${parsed.data.label}'. Pick a different name.`,
    );
  }

  // Blank-password handling (D-07 / SMTP-04 / WR-09). A blank means "keep the stored
  // password". The decrypted plaintext lives ONLY in this local `parsed.data.password`
  // and never reaches an ActionResult, a throw, or a log line (T-061-05-CRED).
  if (parsed.data.password === "") {
    // CREATE always needs a real password — there is no stored row to keep.
    if (id === null) {
      return validationError("password", "Password is required");
    }
    // EDIT: resolve the owned row by id (IDOR-safe, soft-delete-aware).
    const existing = await getSmtpConfigByIdForUser(userId, id);
    if (!existing) {
      return validationError("password", "Password is required");
    }
    // WR-09 gate (LOCKED): host changed + blank password → reject BEFORE any decrypt.
    // No stored credential is ever dialed against a client-changed host.
    if (parsed.data.host !== existing.host) {
      return validationError(
        "password",
        "You changed the server host. Re-enter the password so we can verify it against the new host.",
      );
    }
    // Host unchanged — safe to merge the stored credential for the re-verify.
    parsed.data.password = decrypt({
      enc: existing.password_enc as Buffer,
      iv: existing.password_iv as Buffer,
      tag: existing.password_tag as Buffer,
    });
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

  // Verify succeeded — encrypt the password server-side. This is the ONLY path
  // that stamps verified_at (via create/update in the DAL).
  const { enc, iv, tag } = encrypt(parsed.data.password);
  const persistable = {
    label: parsed.data.label,
    host: parsed.data.host,
    port: parsed.data.port,
    secure: parsed.data.secure,
    username: parsed.data.username,
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: parsed.data.from_addr,
    from_name: parsed.data.from_name ?? null,
  };

  if (id === null) {
    // First server for the account auto-defaults (Pitfall 6); later adds do NOT
    // silently promote themselves over an existing default.
    const isFirstServer = existingConfigs.length === 0;
    const [created] = await createSmtpConfig(userId, {
      ...persistable,
      is_default: isFirstServer,
    });
    // The saved id lets the wizard's test-send step address THIS server.
    return { ok: true, id: created.id };
  }
  const updated = await updateSmtpConfigById(userId, id, persistable);
  // 0-length = the id was not owned / already deleted (IDOR / not-found).
  if (updated.length === 0) {
    return { ok: false, error: { kind: "not_found" } };
  }
  return { ok: true, id };
}

/**
 * Meta-only edit seam (06.1 / D-08): persist ONLY the metadata fields (label +
 * sender identity from_addr / from_name) of ONE owned config, addressed BY ID,
 * WITHOUT a verify round-trip and WITHOUT touching `verified_at` — a rename or
 * display-name/address change does not invalidate a proven connection (Pitfall 6).
 * No SMTP dial happens, so there is no rate-limit here (the "use server" wrapper
 * `updateServerMeta` omits it deliberately).
 *
 * Runs the SAME case-insensitive label-uniqueness check as
 * {@link applyVerifiedConfig} — excluding the row being edited by id so an
 * unchanged label is not a self-conflict — and returns the SAME validationError
 * copy anchored on `label`. Delegates to the id-scoped `updateSmtpConfigMeta`; a
 * 0-length result means the id was not owned / already deleted → `not_found`
 * (T-061-06 IDOR). Replaces the retired userId-only updateFromFields, which
 * clobbered from_addr/from_name on EVERY config the user owned.
 */
export async function updateMetaCore(
  userId: string,
  id: number,
  input: unknown,
): Promise<ActionResult> {
  // Same subset validation as the full form (label/email/trimmed name), so the
  // meta path can never diverge from the connection path (schema is a pick).
  const parsed = smtpMetaFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };
  }

  // Label uniqueness (LOCKED) — identical rule + copy to applyVerifiedConfig,
  // EXCLUDING the row being edited (by id) so an unchanged label is not a clash.
  const existingConfigs = await listSmtpConfigsForUser(userId);
  const wantedLabel = parsed.data.label.trim().toLowerCase();
  const labelClash = existingConfigs.some(
    (c) => c.id !== id && (c.label ?? "").trim().toLowerCase() === wantedLabel,
  );
  if (labelClash) {
    return validationError(
      "label",
      `You already have a server called '${parsed.data.label}'. Pick a different name.`,
    );
  }

  const updated = await updateSmtpConfigMeta(userId, id, {
    label: parsed.data.label,
    from_addr: parsed.data.from_addr,
    from_name: parsed.data.from_name ?? null,
  });
  // 0-length = the id was not owned / already deleted (IDOR / not-found).
  if (updated.length === 0) {
    return { ok: false, error: { kind: "not_found" } };
  }
  return { ok: true, id };
}

/**
 * Set one owned config as the account default (testable seam). Delegates to the
 * transactional DAL swap; a 0-length result means the id was not owned / deleted /
 * unknown, mapped to `not_found` (T-061-06 IDOR).
 */
export async function setDefaultConfigCore(
  userId: string,
  id: number,
): Promise<ActionResult> {
  const changed = await setDefaultSmtpConfig(userId, id);
  if (changed.length === 0) {
    return { ok: false, error: { kind: "not_found" } };
  }
  return { ok: true };
}

/**
 * Soft-delete one owned config (testable seam), guarded by the in-use check
 * (SC5 / T-061-07): if a queued or running campaign still references the config,
 * refuse with `in_use` and delete NOTHING. Otherwise soft-delete; a 0-length
 * result maps to `not_found` (cross-tenant / already deleted / unknown).
 */
export async function softDeleteConfigCore(
  userId: string,
  id: number,
): Promise<ActionResult> {
  // In-use guard FIRST — a config mid-send must not be yanked from the worker.
  if (countActiveSendsForConfig(userId, id) > 0) {
    return { ok: false, error: { kind: "in_use" } };
  }
  const deleted = await softDeleteSmtpConfig(userId, id);
  if (deleted.length === 0) {
    return { ok: false, error: { kind: "not_found" } };
  }
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
