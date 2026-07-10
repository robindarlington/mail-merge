/**
 * lib/smtp/errors — nodemailer verify() failure classifier (SMTP-03 / D-06).
 *
 * Maps a duck-typed nodemailer error ({ code, message }) to a field-anchored
 * classification the UI uses to point the user at the control that's wrong:
 *   auth       → username/password rejected (EAUTH)
 *   tls        → TLS-mode mismatch (SSL/handshake shape, or greeting timeout)
 *   connection → host/port unreachable (DNS/connect/socket/timeout)
 *   unknown    → anything else, anchored to the form as a whole
 *
 * SECURITY (T-2-CRED / Pitfall 5): this returns a VALUE only. The raw Error is
 * NEVER passed outward from here; callers read the returned `kind`/`field` and,
 * separately, a message-only `raw` string (no config, no credentials). Mirrors
 * the read-.code/.message-and-return-a-value style of lib/core/send.ts sendOne.
 */

/** The four failure classes the onboarding UI distinguishes (SMTP-03). */
export type VerifyErrorKind = "auth" | "connection" | "tls" | "unknown";

/** The form control a classification anchors its error message to (D-06). */
export type VerifyErrorField = "auth" | "hostPort" | "tlsMode" | "form";

/**
 * Classify a nodemailer verify() rejection into { kind, field }. Pure and total:
 * every input maps to exactly one classification; never throws, never logs.
 */
export function classifyVerifyError(err: {
  code?: string;
  message?: string;
}): { kind: VerifyErrorKind; field: VerifyErrorField } {
  const msg = err.message ?? "";

  // Auth rejection is unambiguous — nodemailer sets EAUTH after a failed login.
  if (err.code === "EAUTH") return { kind: "auth", field: "auth" };

  // TLS-shaped: an implicit-TLS handshake against a STARTTLS/plaintext port
  // surfaces as an SSL "wrong version number"-style ESOCKET error; a STARTTLS
  // dial against an implicit-TLS port stalls at the greeting (greeting timeout).
  // (Assumption A1 — pinned empirically by verify.test.ts's smtp-server fixture.)
  if (/wrong version number|ssl|tls|handshake/i.test(msg)) {
    return { kind: "tls", field: "tlsMode" };
  }
  if (err.code === "ETIMEDOUT" && /greeting/i.test(msg)) {
    return { kind: "tls", field: "tlsMode" };
  }

  // Reachability failures — DNS, connect refusal, socket, or an unqualified
  // timeout — all anchor to the host/port fields.
  if (
    err.code === "EDNS" ||
    err.code === "ECONNECTION" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ESOCKET"
  ) {
    return { kind: "connection", field: "hostPort" };
  }

  return { kind: "unknown", field: "form" };
}
