/**
 * lib/smtp — the SMTP onboarding verification engine (SMTP-01/02/03).
 *
 * Barrel export consumed by the Server Action layer (plan 02-05) and the wizard
 * form (client-side schema). Composes lib/core/send.ts's transport factory;
 * contains no DB, Clerk, or Next dependency.
 */

export { smtpFormSchema, isPrivateHostLiteral } from "./schema";
export type { SmtpFormValues } from "./schema";

export { classifyVerifyError } from "./errors";
export type { VerifyErrorKind, VerifyErrorField } from "./errors";

export { verifySmtp, ONBOARDING_TIMEOUTS } from "./verify";
export type { VerifyOutcome } from "./verify";
