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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  parseCsv,
  detectEmailColumn,
  countInvalidEmails,
  fillMessage,
  type MessageTemplate,
} from "../../../lib/core/index.js";

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
 * Build the mail-merge MCP server with all four tools registered.
 * Returns a fresh instance per call (each stdio connection / test gets its own,
 * including its own in-memory confirm-token map — added in Task 2).
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "mail-merge", version: "1.0.0" });

  // --- validate-csv (read-only) ---------------------------------------------
  server.registerTool(
    "validate-csv",
    {
      description:
        "Parse CSV text and report its columns, row count, the detected email column, and how many rows have an invalid email — computed by the same lib/core engine the CLI uses.",
      inputSchema: { csv: z.string().describe("Raw CSV text (a header row + one row per recipient).") },
      outputSchema: {
        columns: z.array(z.string()),
        rowCount: z.number(),
        detectedEmailColumn: z.string().nullable(),
        invalidEmailCount: z.number(),
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

  return server;
}
