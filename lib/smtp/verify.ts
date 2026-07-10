/**
 * lib/smtp/verify — the live SMTP verification engine (SMTP-03 / D-04 / D-05).
 *
 * Dials the user's server with SHORT timeouts (Pitfall 4 — nodemailer's defaults
 * are 120s connect / 30s greeting / 600s socket / 30s DNS, far too slow for an
 * onboarding spinner), runs transport.verify(), and on failure classifies the
 * error into a field-anchored { kind, field } (lib/smtp/errors).
 *
 * D-05 auto-retry: when the failure is TLS-shaped, the alternate `secure` mode is
 * probed ONCE. If the alternate succeeds we do NOT save — we return a `suggestion`
 * so the UI can offer a one-click "switch mode & verify".
 *
 * SECURITY:
 *  - T-2-TLS: `requireTLS: !secure` — in STARTTLS mode the connection must upgrade
 *    to TLS and never silently stay cleartext.
 *  - T-2-MITM: we NEVER disable TLS certificate verification; nodemailer's secure
 *    defaults (validate the cert chain) stand — the reject-unauthorized flag is
 *    left at its safe default and never turned off.
 *  - T-2-CRED: the returned value carries a message-only `raw` string — never the
 *    config, credentials, or the raw Error object. No logging here at all.
 *  - The transport socket is ALWAYS closed in a finally, so a hung dial can't leak
 *    a file descriptor.
 *
 * Composes lib/core/send.ts's single transport factory (createSmtpTransport) with
 * the additive onboarding options — it does not re-implement transport code.
 */

import { createSmtpTransport } from "../core/send";
import {
  classifyVerifyError,
  type VerifyErrorKind,
  type VerifyErrorField,
} from "./errors";
import type { SmtpFormValues } from "./schema";

/**
 * Short per-attempt timeouts for onboarding (Pitfall 4). A refused/typo'd host
 * fails within ~15s instead of ~120s.
 */
export const ONBOARDING_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  dnsTimeout: 10_000,
} as const;

/**
 * The result verifySmtp returns. Never throws outward — a failure is a value.
 * `suggestion` is present only when the D-05 alternate-mode probe succeeded:
 *   "starttls" → the user picked implicit SSL but the server wants STARTTLS
 *   "implicit" → the user picked STARTTLS but the server wants implicit SSL
 */
export type VerifyOutcome =
  | { ok: true }
  | {
      ok: false;
      kind: VerifyErrorKind;
      field: VerifyErrorField;
      raw: string;
      suggestion?: "starttls" | "implicit";
    };

/** One verify attempt against a chosen TLS mode. Always closes the socket. */
async function attempt(
  input: SmtpFormValues,
  secure: boolean,
): Promise<{ ok: true } | { ok: false; err: { code?: string; message?: string } }> {
  const transport = createSmtpTransport({
    host: input.host,
    port: input.port,
    secure,
    // STARTTLS mode must not silently downgrade to cleartext (T-2-TLS).
    requireTLS: !secure,
    auth: { user: input.username, pass: input.password },
    ...ONBOARDING_TIMEOUTS,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err as { code?: string; message?: string } };
  } finally {
    // Never leave the socket dangling, even on a thrown/hung verify.
    transport.close();
  }
}

/**
 * Verify a user's SMTP config live. On a TLS-shaped failure, probe the alternate
 * mode once (D-05) and, if that works, return a switch suggestion WITHOUT saving.
 */
export async function verifySmtp(input: SmtpFormValues): Promise<VerifyOutcome> {
  const primary = await attempt(input, input.secure);
  if (primary.ok) return { ok: true };

  const classified = classifyVerifyError(primary.err);
  const raw = primary.err.message ?? "";

  if (classified.kind === "tls") {
    const alternate = await attempt(input, !input.secure);
    if (alternate.ok) {
      // The alternate mode works — offer the one-click switch, do not save (D-05).
      return {
        ok: false,
        ...classified,
        raw,
        suggestion: input.secure ? "starttls" : "implicit",
      };
    }
  }

  return { ok: false, ...classified, raw };
}
