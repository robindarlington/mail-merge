/**
 * lib/core — the pure, reusable mail-merge engine lifted from the CLI.
 *
 * Barrel export consumed by Phase 5 (synchronous test-send) and Phase 6 (the
 * background worker's send loop). Imports only nodemailer + papaparse; contains
 * no DB, crypto, Clerk, or Next dependency.
 */

export { fill, fillMessage } from "./fill";
export type { Row as FillRow, MessageTemplate } from "./fill";

export { extractTokens, analyzeMerge } from "./merge";
export type { MergeAnalysis } from "./merge";

export { parseCsv, detectEmailColumn, countInvalidEmails, isValidEmail } from "./csv";
export type { ParsedCsv, Row as CsvRow } from "./csv";

export { detectAttachmentColumn } from "./attachment-column";

export {
  createSmtpTransport,
  verifyTransport,
  sendOne,
  throttle,
  DEFAULT_DELAY_MS,
} from "./send";
export type {
  SmtpConfig,
  MailTransport,
  SendArgs,
  SendResult,
} from "./send";
