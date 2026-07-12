/**
 * lib/smtp/schema — the shared zod 4 SMTP onboarding form schema (SMTP-01/SMTP-02).
 *
 * This ONE schema is parsed on both the client (react-hook-form resolver) and the
 * server (the verifyAndSave action, plan 02-05) so validation can never diverge.
 *
 * SMTP-01: every field (host, port, username, password, from address) is validated.
 * SMTP-02: `secure` is an EXPLICIT boolean the user chooses — TLS mode is never
 *          inferred from the port number here or in lib/core/send.ts.
 *
 * SSRF hygiene (T-2-SSRF / Pitfall 9): because BYO-SMTP dials a user-supplied
 * host:port, the `host` field rejects loopback / link-local / RFC1918 literals so
 * verify()'s distinguishable errors cannot be used to probe the VPS's internal
 * network. v1 blocks literal private ranges (cheap); DNS-resolve-then-check is a
 * later hardening step (RESEARCH assumption A5).
 *
 * zod 4 idioms only (Pitfall 7): `z.email()` top-level rather than the removed
 * zod-3 chained string-email form, and `z.coerce.number().int().min(1).max(65535)`
 * for the port.
 */

import { z } from "zod";

/**
 * Reject host literals that point at the server's own network (SSRF hygiene).
 * Only literal IPs / `localhost` are screened — hostnames that resolve to private
 * ranges are out of scope for v1 (RESEARCH assumption A5). Returns true when the
 * host is a DISALLOWED private/loopback/link-local literal.
 */
export function isPrivateHostLiteral(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost") return true;

  // Strip an optional IPv6 zone id and brackets, e.g. "[::1]" / "fe80::1%eth0".
  const v6 = h.replace(/^\[|\]$/g, "").split("%")[0];
  if (v6 === "::1") return true; // IPv6 loopback
  if (v6 === "::") return true; // unspecified
  if (/^fe80:/i.test(v6)) return true; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true; // IPv6 unique-local (fc00::/7)
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — fall through to the v4 check below.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(v6);
  const v4candidate = mapped ? mapped[1] : h;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4candidate);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  return false;
}

export const smtpFormSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1, "Host is required")
    .refine((h) => !isPrivateHostLiteral(h), {
      message:
        "Enter a public mail server host. Private, loopback and link-local addresses aren't allowed.",
    }),
  // Explicit port; coerced because the form control yields a string. SMTP-02:
  // the port is validated but NEVER used to infer the TLS mode.
  port: z.coerce.number().int().min(1).max(65535),
  // Explicit TLS mode (SMTP-02) — radio: "Implicit SSL (465)" | "STARTTLS (587)".
  secure: z.boolean(),
  username: z.string().min(1, "Username is required"),
  // The BASE schema ALWAYS requires a password — this is the create flow, where a
  // real credential must be supplied. The edit "leave blank to keep" relaxation
  // (D-07) lives ONLY in `smtpEditFormSchema` below, never here.
  password: z.string().min(1, "Password is required"),
  from_addr: z.email("Enter a valid from address"),
  from_name: z.string().trim().optional(),
});

export type SmtpFormValues = z.infer<typeof smtpFormSchema>;

/**
 * Edit-mode variant of {@link smtpFormSchema} that ALLOWS a blank password
 * ("leave blank to keep your current password", D-07). Every other field keeps
 * the base validation; only `password` is relaxed to permit "". A blank here is a
 * signal to the server (`applyVerifiedConfig`) to merge the STORED password before
 * verify/persist — the client never sees or re-sends the stored secret.
 */
export const smtpEditFormSchema = smtpFormSchema.extend({
  password: z.string(),
});

export type SmtpEditFormValues = z.infer<typeof smtpEditFormSchema>;
