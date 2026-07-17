/**
 * args — the CLI's pure argument contract (SC-1 / SC-2 / SC-4).
 *
 * `parseCliArgs(argv)` uses node:util `parseArgs` in STRICT mode. The security
 * guarantee (SC-2 / T-081-01) is structural: there is DELIBERATELY no
 * `password` / `smtp-pass` option in the schema, so strict mode REJECTS any such
 * flag — a secret can never be placed in argv. The SMTP password only ever
 * arrives via `.env` / prompt (as in send-credentials.ts), never the command line.
 *
 * `--delay-ms` is coerced with the worker's envInt discipline (worker/index.ts):
 * a non-finite or ≤0 value is REJECTED naming the flag, never silently degraded
 * to NaN (T-081-05).
 *
 * PURITY: no filesystem, no network — a pure argv → options transform. The only
 * import is the DEFAULT_DELAY_MS constant from lib/core (single source of truth
 * for the 3000ms throttle, carried forward from the CLI's DELAY_MS).
 */

import { parseArgs } from "node:util";

import { DEFAULT_DELAY_MS } from "../../../lib/core/index.js";

export type CliMode = "dry" | "test" | "live";

export interface CliOptions {
  /** Run mode derived from --send / --test (defaults to dry-run). */
  mode: CliMode;
  /** Path to the recipients CSV (--csv). */
  csv?: string;
  /** Path to the message template (--template). */
  template?: string;
  /** When mode==="test", the single address every message is previewed to. */
  testAddr?: string;
  /** Explicit email-column override (--email-column); else auto-detected. */
  emailColumn?: string;
  /** Inter-send throttle in ms (default DEFAULT_DELAY_MS = 3000). */
  delayMs: number;
  /** Optional path to an env file the caller loads (--env-file). */
  envFile?: string;
  /** Optional receipts/output path (--receipts). */
  receipts?: string;
  /** Disable receipt writing (--no-receipts). */
  noReceipts: boolean;
  /** Resume a previously interrupted run (--resume). */
  resume: boolean;
  /** Show help and exit (--help / -h). */
  help: boolean;
}

/**
 * Parse a raw argv slice (WITHOUT node/script head — pass process.argv.slice(2))
 * into a typed {@link CliOptions}. Throws on unknown flags (strict), a missing
 * --test address, or a non-numeric/≤0 --delay-ms.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      csv: { type: "string" },
      template: { type: "string" },
      test: { type: "string" },
      send: { type: "boolean" },
      "email-column": { type: "string" },
      "delay-ms": { type: "string" },
      "env-file": { type: "string" },
      receipts: { type: "string" },
      "no-receipts": { type: "boolean" },
      resume: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  // --delay-ms: coerce like worker/index.ts envInt — reject non-finite/≤0 rather
  // than degrading to NaN (T-081-05). Name the flag in the error, never a value.
  let delayMs = DEFAULT_DELAY_MS;
  const rawDelay = values["delay-ms"];
  if (rawDelay !== undefined) {
    const n = Number(rawDelay);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("--delay-ms must be a positive number of milliseconds");
    }
    delayMs = n;
  }

  // Mode matrix, mirroring send-credentials.ts main(): --test ADDR > --send > dry.
  const testAddr = values.test;
  let mode: CliMode;
  if (testAddr !== undefined) {
    if (!testAddr) {
      throw new Error("--test needs an address, e.g. --test you@example.com");
    }
    mode = "test";
  } else if (values.send) {
    mode = "live";
  } else {
    mode = "dry";
  }

  return {
    mode,
    csv: values.csv,
    template: values.template,
    testAddr,
    emailColumn: values["email-column"],
    delayMs,
    envFile: values["env-file"],
    receipts: values.receipts,
    noReceipts: Boolean(values["no-receipts"]),
    resume: Boolean(values.resume),
    help: Boolean(values.help),
  };
}
