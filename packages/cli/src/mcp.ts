/**
 * mcp — the stdio MCP server: the same lib/core engine exposed to AI agents (SC-3).
 *
 * `buildServer()` returns an `McpServer` with four tools that are THIN adapters
 * over the exact same code the CLI uses — never a second implementation:
 *   - validate-csv  → lib/core parseCsv + detectEmailColumn + countInvalidEmails
 *   - preview-merge → lib/core parseCsv + fillMessage (per-row subject/body)
 *   - test-send     → run.ts runSend (mode "test")   [Task 2]
 *   - send          → run.ts runSend (mode "live"), gated by a two-step confirm
 *                     token (D-04)                    [Task 2]
 *
 * Security discipline (threat model):
 *   - The read tools take CSV TEXT, not a filesystem path (T-081-FS): the stdio
 *     server never reads the host FS on the agent's behalf. The only FS write is
 *     the explicit opt-in `receiptsPath` on send/test-send.
 *   - Every tool declares a zod `inputSchema`, so the SDK refuses malformed args
 *     BEFORE the callback runs (T-081-05).
 *   - The SMTP password arrives in a tool param object and is NEVER echoed into a
 *     tool result or logged (T-081-02). This module never `console.*`s a CSV cell,
 *     subject, body, or password.
 *
 * Import paths are the VERIFIED 1.29.0 API (RESEARCH Pattern 1) — `registerTool`
 * with RAW ZOD SHAPES for input/output schemas, NOT the unreleased v2 README.
 */

import { createHash, randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  parseCsv,
  detectEmailColumn,
  countInvalidEmails,
  fillMessage,
  DEFAULT_DELAY_MS,
  type MessageTemplate,
  type SmtpConfig,
} from "../../../lib/core/index.js";
import { runSend } from "./run.js";

/** The exact no-receipts warning surfaced when `send`/`test-send` gets no path (D-12). */
const NO_RECEIPTS_WARNING = "No receipts file will be written for this send.";

/**
 * How long a minted confirm token stays valid (WR-07). A token previewed long
 * ago attests to params the conversation has likely moved past — it must not be
 * able to fire a live batch. Expired tokens are purged on every `send` call, so
 * the map cannot grow without bound across a long agent session either.
 */
const CONFIRM_TTL_MS = 10 * 60 * 1000;

/**
 * Count STRUCTURAL parse errors worth warning about (WR-05): field-count
 * mismatches, quote errors — but NOT papaparse's benign `UndetectableDelimiter`
 * meta-error, which fires on every legitimate single-column CSV.
 */
export function countStructuralParseErrors(
  parseErrors: { code?: string }[],
): number {
  return parseErrors.filter((e) => e.code !== "UndetectableDelimiter").length;
}

/** Standard tool-error result: a string message, isError set, no secret. */
function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Standard success result: JSON text mirror + typed structuredContent. */
function toolOk<T extends Record<string, unknown>>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * The SMTP param shape agents pass on `test-send`/`send`. TLS is EXPLICIT
 * (`secure` boolean — never inferred from the port, carry-forward discipline).
 * The password arrives here and is mapped straight into the runSend `auth`; it is
 * NEVER placed into a tool result, preview, or log.
 */
const smtpSchema = z.object({
  host: z.string(),
  port: z.number(),
  secure: z.boolean().describe("Explicit TLS on/off — never inferred from the port."),
  user: z.string(),
  pass: z.string().describe("SMTP password; used for the send and never echoed back."),
  requireTls: z
    .boolean()
    .optional()
    .describe(
      "When secure is false, require the STARTTLS upgrade (default true — T-2-TLS). Set false ONLY for a genuinely plaintext-only local relay.",
    ),
});
type SmtpParam = z.infer<typeof smtpSchema>;

/** Map the flat MCP smtp param into lib/core's SmtpConfig (auth nesting). */
function toSmtpConfig(p: SmtpParam): SmtpConfig {
  return {
    host: p.host,
    port: p.port,
    secure: p.secure,
    auth: { user: p.user, pass: p.pass },
    // STARTTLS-stripping defense (T-2-TLS): on a cleartext connection, REQUIRE
    // the upgrade unless the caller explicitly opts out with requireTls: false.
    ...(p.secure ? {} : { requireTLS: p.requireTls ?? true }),
  };
}

/**
 * A stable hash of ALL send params (INCLUDING resolved delayMs + receiptsPath and
 * the delivered `fromName` display name, but NOT the confirmToken). The two-step
 * token is keyed to this so an agent cannot preview one payload then swap in a
 * different one on confirm (D-04).
 */
function hashSendParams(input: {
  csv: string;
  subject: string;
  body: string;
  smtp: SmtpParam;
  from: string;
  fromName: string | null;
  delayMs: number;
  receiptsPath: string | null;
}): string {
  // Fixed key order → deterministic JSON → stable digest across the two calls.
  const canonical = JSON.stringify([
    input.csv,
    input.subject,
    input.body,
    input.smtp.host,
    input.smtp.port,
    input.smtp.secure,
    input.smtp.requireTls ?? null,
    input.smtp.user,
    input.smtp.pass,
    input.from,
    input.fromName,
    input.delayMs,
    input.receiptsPath,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Progress sink for MCP-driven sends: stderr, NEVER stdout.
 *
 * On the real `mail-merge mcp` stdio server, stdout IS the JSON-RPC channel — a
 * per-row progress line there would corrupt the protocol. Passing this sink via
 * runSend's `log` seam (instead of monkey-patching the global `console.log`) is
 * reentrant and safe under overlapping tool calls: no global state is ever
 * swapped, so a concurrent send can never leak progress onto stdout.
 */
const stderrLog = (line: string): void => console.error(line);

/**
 * Build the mail-merge MCP server with all four tools registered.
 * Returns a fresh instance per call (each stdio connection / test gets its own,
 * including its own in-memory confirm-token map — added in Task 2).
 *
 * `opts.now` is a clock seam (defaults to `Date.now`) so tests can drive the
 * confirm-token TTL (WR-07) without real waiting.
 */
export function buildServer(opts: { now?: () => number } = {}): McpServer {
  const now = opts.now ?? Date.now;
  const server = new McpServer({ name: "mail-merge", version: "1.0.0" });

  // Process-local one-time confirm tokens for `send` (D-04 / RESEARCH Pattern 3).
  // One stdio server == one agent session, so an in-memory Map needs no
  // persistence; a token is consumed (deleted) on the confirming call.
  const confirmTokens = new Map<string, { paramsHash: string; createdAt: number }>();

  // --- validate-csv (read-only) ---------------------------------------------
  server.registerTool(
    "validate-csv",
    {
      description:
        "Parse CSV text and report its columns, row count, the detected email column, how many rows have an invalid email, and how many STRUCTURAL parse errors (ragged rows, bad quoting) the parse produced — computed by the same lib/core engine the CLI uses.",
      inputSchema: { csv: z.string().describe("Raw CSV text (a header row + one row per recipient).") },
      outputSchema: {
        columns: z.array(z.string()),
        rowCount: z.number(),
        detectedEmailColumn: z.string().nullable(),
        invalidEmailCount: z.number(),
        parseErrorCount: z
          .number()
          .describe("Structural parse errors (field-count mismatch, quote errors); non-zero means rows may have missing/shifted cells."),
      },
    },
    async ({ csv }) => {
      try {
        const parsed = parseCsv(csv);
        const detected = detectEmailColumn(parsed.columns, parsed.rows);
        const invalidEmailCount = detected
          ? countInvalidEmails(parsed.rows, detected)
          : parsed.invalidEmailCount;
        return toolOk({
          columns: parsed.columns,
          rowCount: parsed.rows.length,
          detectedEmailColumn: detected,
          invalidEmailCount,
          parseErrorCount: countStructuralParseErrors(parsed.parseErrors),
        });
      } catch (e) {
        return toolError(`validate-csv failed: ${(e as Error).message}`);
      }
    },
  );

  // --- preview-merge (read-only) --------------------------------------------
  server.registerTool(
    "preview-merge",
    {
      description:
        "Merge a subject/body template against each CSV row and return the per-row filled subject and body (via lib/core.fillMessage) — merge parity with the CLI. Optionally limit the number of rows returned.",
      inputSchema: {
        csv: z.string().describe("Raw CSV text."),
        subject: z.string().describe("Subject template with {{column}} tokens."),
        body: z.string().describe("Body template with {{column}} tokens."),
        limit: z.number().optional().describe("Max rows to preview (default: all)."),
      },
      outputSchema: {
        rows: z.array(z.object({ to: z.string(), subject: z.string(), body: z.string() })),
      },
    },
    async ({ csv, subject, body, limit }) => {
      try {
        const parsed = parseCsv(csv);
        const emailColumn = detectEmailColumn(parsed.columns, parsed.rows);
        const template: MessageTemplate = { subject, body };
        const capped =
          typeof limit === "number" ? parsed.rows.slice(0, Math.max(0, limit)) : parsed.rows;
        const rows = capped.map((row) => {
          const filled = fillMessage(template, row);
          return {
            to: emailColumn ? (row[emailColumn] ?? "") : "",
            subject: filled.subject,
            body: filled.body,
          };
        });
        return toolOk({ rows });
      } catch (e) {
        return toolError(`preview-merge failed: ${(e as Error).message}`);
      }
    },
  );

  // Shared input fields for the two send tools (SMTP config + template + csv).
  const sendInputBase = {
    csv: z.string().describe("Raw CSV text (a header row + one row per recipient)."),
    subject: z.string().describe("Subject template with {{column}} tokens."),
    body: z.string().describe("Body template with {{column}} tokens."),
    smtp: smtpSchema,
    from: z.string().describe("Envelope From address."),
    fromName: z.string().optional().describe("Optional From display name."),
    delayMs: z
      .number()
      .optional()
      .describe(`Inter-send throttle in ms (default ${DEFAULT_DELAY_MS} when absent).`),
    receiptsPath: z
      .string()
      .optional()
      .describe("Opt-in JSONL receipts path; when set, receipts are written and resume skips already-sent rows."),
  };

  // --- test-send (proof the whole batch to one address) ---------------------
  server.registerTool(
    "test-send",
    {
      description:
        "Proof the whole merge by sending EVERY row's personalized message to a single test address, over the supplied SMTP. Delegates to the same run.ts driver the CLI uses; optionally writes JSONL receipts when receiptsPath is given.",
      inputSchema: {
        ...sendInputBase,
        testAddr: z.string().describe("The single address every test message is delivered to."),
      },
      outputSchema: {
        attempted: z.number(),
        sent: z.number(),
        failed: z.number(),
        receiptsPath: z.string().nullable(),
        receiptsWarning: z.string().optional(),
      },
    },
    async ({ csv, subject, body, smtp, from, fromName, testAddr, delayMs, receiptsPath }) => {
      try {
        const parsed = parseCsv(csv);
        const parseErrorCount = countStructuralParseErrors(parsed.parseErrors);
        if (parseErrorCount > 0) {
          // stderr only — stdout is the JSON-RPC channel (WR-05).
          console.error(
            `WARNING: CSV parse produced ${parseErrorCount} structural error(s) — rows may have missing/shifted cells.`,
          );
        }
        const emailColumn = detectEmailColumn(parsed.columns, parsed.rows) ?? "";
        const resolvedDelay = delayMs ?? DEFAULT_DELAY_MS;
        const result = await runSend({
          mode: "test",
          rows: parsed.rows,
          emailColumn,
          template: { subject, body },
          smtp: toSmtpConfig(smtp),
          from,
          fromName,
          testAddr,
          delayMs: resolvedDelay,
          receiptsPath,
          noReceipts: !receiptsPath,
          log: stderrLog,
        });
        return toolOk({
          attempted: result.sent + result.failed,
          sent: result.sent,
          failed: result.failed,
          receiptsPath: receiptsPath ?? null,
          // D-12 parity with `send` (WR-08): no path → the explicit warning.
          ...(receiptsPath ? {} : { receiptsWarning: NO_RECEIPTS_WARNING }),
        });
      } catch (e) {
        return toolError(`test-send failed: ${(e as Error).message}`);
      }
    },
  );

  // --- send (live, gated by a two-step confirm token) -----------------------
  server.registerTool(
    "send",
    {
      description:
        "Send one personalized message per CSV row over the supplied SMTP. GATED: the first call (no confirmToken) returns a preview + a one-time confirmToken and delivers NOTHING; call again with that token to actually send. Delegates to the same run.ts driver the CLI uses.",
      inputSchema: {
        ...sendInputBase,
        confirmToken: z
          .string()
          .optional()
          .describe("The one-time token from a prior preview call; required to actually deliver."),
      },
    },
    async ({ csv, subject, body, smtp, from, fromName, delayMs, receiptsPath, confirmToken }) => {
      try {
        const parsed = parseCsv(csv);
        const parseErrorCount = countStructuralParseErrors(parsed.parseErrors);
        if (parseErrorCount > 0) {
          // stderr only — stdout is the JSON-RPC channel (WR-05).
          console.error(
            `WARNING: CSV parse produced ${parseErrorCount} structural error(s) — rows may have missing/shifted cells.`,
          );
        }
        const emailColumn = detectEmailColumn(parsed.columns, parsed.rows);
        if (!emailColumn) {
          return toolError(
            "could not detect an email column in the CSV — no recipient address to send to.",
          );
        }
        // TTL purge (WR-07): drop expired tokens on EVERY send call, so a stale
        // token can never confirm a batch and the map cannot grow unbounded.
        for (const [t, rec] of confirmTokens) {
          if (now() - rec.createdAt > CONFIRM_TTL_MS) confirmTokens.delete(t);
        }

        const resolvedDelay = delayMs ?? DEFAULT_DELAY_MS;
        const paramsHash = hashSendParams({
          csv,
          subject,
          body,
          smtp,
          from,
          fromName: fromName ?? null,
          delayMs: resolvedDelay,
          receiptsPath: receiptsPath ?? null,
        });

        // Confirming call: require a token that matches THESE exact params, then
        // consume it and deliver. A wrong/expired/mismatched token is refused.
        if (confirmToken) {
          const rec = confirmTokens.get(confirmToken);
          if (!rec || rec.paramsHash !== paramsHash) {
            return toolError(
              "Invalid or expired confirm token. Call send WITHOUT a token to get a fresh preview + token, then confirm with matching params.",
            );
          }
          confirmTokens.delete(confirmToken); // consume — a replay is refused
          const result = await runSend({
            mode: "live",
            rows: parsed.rows,
            emailColumn,
            template: { subject, body },
            smtp: toSmtpConfig(smtp),
            from,
            fromName,
            delayMs: resolvedDelay,
            receiptsPath,
            noReceipts: !receiptsPath,
            resume: Boolean(receiptsPath),
            log: stderrLog,
          });
          return toolOk({
            attempted: result.sent + result.failed,
            sent: result.sent,
            failed: result.failed,
            receiptsPath: receiptsPath ?? null,
            ...(receiptsPath ? {} : { receiptsWarning: NO_RECEIPTS_WARNING }),
          });
        }

        // Preview call: mint a one-time token keyed to these params, deliver NOTHING.
        const token = randomUUID();
        confirmTokens.set(token, { paramsHash, createdAt: now() });
        return toolOk({
          preview: {
            recipientCount: parsed.rows.length,
            // Structural CSV errors the confirming agent should see (WR-05).
            parseErrorCount,
            subject,
            from,
            // The delivered From display name MUST be visible to the confirming
            // agent/human — it is part of what the token attests to (CR-02).
            fromName: fromName ?? null,
            delayMs: resolvedDelay,
            receiptsPath: receiptsPath ?? null,
            ...(receiptsPath ? {} : { receiptsWarning: NO_RECEIPTS_WARNING }),
          },
          confirmToken: token,
        });
      } catch (e) {
        return toolError(`send failed: ${(e as Error).message}`);
      }
    },
  );

  return server;
}
