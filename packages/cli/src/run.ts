/**
 * run — the SINGLE shared send driver (SC-1 / SC-2 / T-081-DUP / T-081-02).
 *
 * `runSend` is the one send-orchestration module BOTH front-ends call: the CLI's
 * `--test`/`--send` dispatch (bin.ts, this plan) and — in Plan 03 — the MCP
 * `send`/`test-send` tools. Building the send loop once here is deliberate
 * (RESEARCH Anti-Pattern "building the send loop twice"): the two front-ends can
 * never diverge on verify-gating, throttling, receipts, or resume.
 *
 * The loop is lifted from send-credentials.ts (banners, `[i+1/N] sent -> addr` /
 * `FAILED -> addr` lines, DELAY_MS throttle between sends) but delegates every
 * real operation to lib/core: `createSmtpTransport` (explicit TLS), a pre-loop
 * `verifyTransport` gate, `sendOne` (never throws — one bad row cannot abort the
 * batch), and `throttle`. It NEVER logs the password/auth; failure lines carry
 * only `res.error.message`.
 *
 * Receipts (on unless `--no-receipts`): one fsynced JSONL line per delivered row.
 * `--resume` reads the already-`sent` set and skips those addresses, so a re-run
 * never re-delivers a recorded recipient (at-least-once, documented in receipts.ts).
 */

import {
  createSmtpTransport,
  fillMessage,
  sendOne,
  throttle,
  verifyTransport,
  DEFAULT_DELAY_MS,
  type MailTransport,
  type MessageTemplate,
  type FillRow,
  type SmtpConfig,
} from "../../../lib/core/index.js";

import { appendReceipt, readSentSet, type ReceiptEntry } from "./receipts.js";

/** Transport surface runSend uses: the lib/core send contract plus `close()`. */
export type SendTransport = MailTransport & { close?(): void };

/** Factory seam (defaults to createSmtpTransport) so tests inject a recorder. */
export type TransportFactory = (smtp: SmtpConfig) => SendTransport;

export type RunSendMode = "dry" | "test" | "live";

export interface RunSendOpts {
  /** dry = list only; test = whole batch to one address; live = one per row. */
  mode: RunSendMode;
  /** Recipient rows (already parsed from the CSV). */
  rows: FillRow[];
  /** Column holding each row's destination address (ignored in test mode). */
  emailColumn: string;
  /** Subject/body template merged per row. */
  template: MessageTemplate;
  /** Connection config (pass already decrypted; secure is explicit). */
  smtp: SmtpConfig;
  /** Envelope From address. */
  from: string;
  /** Optional From display name. */
  fromName?: string;
  /** In test mode, the single address every message is delivered to. */
  testAddr?: string;
  /** Inter-send throttle in ms (default DEFAULT_DELAY_MS). */
  delayMs?: number;
  /** Where to append JSONL receipts; omit (or set noReceipts) to disable. */
  receiptsPath?: string;
  /** Disable receipt writing even when a path is present. */
  noReceipts?: boolean;
  /** Skip addresses already recorded `sent` in receiptsPath. */
  resume?: boolean;
  /** Transport factory seam (tests inject a recorder); defaults to real SMTP. */
  createTransport?: TransportFactory;
  /**
   * Progress sink (defaults to `console.log`). The MCP server passes a
   * stderr-backed sink here so per-row progress can NEVER land on stdout — the
   * JSON-RPC channel — even with overlapping tool calls (no global patching).
   */
  log?: (line: string) => void;
}

/** Tallies returned to the caller (also used by the MCP tools in Plan 03). */
export interface RunSendResult {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Compose the envelope From, honouring an optional display name. */
function formatFrom(from: string, fromName?: string): string {
  return fromName ? `${fromName} <${from}>` : from;
}

/**
 * Drive a dry / test / live send. For test/live it builds the transport, runs the
 * pre-loop verify gate, then iterates rows: resolve the destination, merge the
 * template, send via lib/core.sendOne, log a per-row line, append a receipt, and
 * throttle between sends. Returns per-run tallies.
 */
export async function runSend(opts: RunSendOpts): Promise<RunSendResult> {
  const {
    mode,
    rows,
    emailColumn,
    template,
    smtp,
    from,
    fromName,
    testAddr,
    delayMs = DEFAULT_DELAY_MS,
    receiptsPath,
    noReceipts,
    resume,
    createTransport = createSmtpTransport as TransportFactory,
    log = console.log,
  } = opts;

  if (mode === "test" && !testAddr) {
    throw new Error("test mode requires a test address");
  }

  // Mode banner (send-credentials.ts parity).
  if (mode === "dry") log("DRY RUN: nothing will be sent.\n");
  else if (mode === "test") log(`TEST mode: every message goes to ${testAddr}\n`);
  else log("LIVE mode: messages go to each real recipient\n");

  const total = rows.length;
  const fromField = formatFrom(from, fromName);
  const writeReceipts = !noReceipts && Boolean(receiptsPath);
  const sentSet = resume && receiptsPath ? readSentSet(receiptsPath) : new Set<string>();

  let transport: SendTransport | undefined;
  if (mode !== "dry") {
    transport = createTransport(smtp);
    // Pre-loop connectivity/auth gate — fail fast before iterating recipients.
    await verifyTransport(transport);
    log("SMTP connection OK.\n");
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < total; i++) {
      const row = rows[i];
      const to = mode === "test" ? (testAddr as string) : (row[emailColumn] ?? "");
      const tag = `[${i + 1}/${total}]`;

      if (resume && sentSet.has(to)) {
        skipped++;
        log(`${tag} skip (already sent) -> ${to}`);
        continue;
      }

      // Each row keeps its OWN merged subject/body even in test mode (--test parity).
      const filled = fillMessage(template, row);

      if (mode === "dry") {
        log(`${tag} would send -> ${to}  |  ${filled.subject}`);
        continue;
      }

      const res = await sendOne({
        transport: transport as MailTransport,
        from: fromField,
        to,
        subject: filled.subject,
        body: filled.body,
      });

      if (res.ok) {
        sent++;
        log(`${tag} sent -> ${to}`);
      } else {
        failed++;
        // Error MESSAGE only — never the auth object/password.
        log(`${tag} FAILED -> ${to}: ${res.error.message}`);
      }

      if (writeReceipts && receiptsPath) {
        const entry: ReceiptEntry = res.ok
          ? { to, status: "sent", messageId: res.messageId, timestamp: new Date().toISOString() }
          : { to, status: "failed", error: res.error.message, timestamp: new Date().toISOString() };
        appendReceipt(receiptsPath, entry);
      }

      if (i < total - 1) await throttle(delayMs);
    }
  } finally {
    transport?.close?.();
  }

  if (mode === "dry") log("\nDry run complete.");
  else log(`\nDone. ${sent}/${total} sent${skipped ? `, ${skipped} skipped` : ""}.`);

  return { total, sent, failed, skipped };
}
