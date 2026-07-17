#!/usr/bin/env node
/**
 * bin — the `mail-merge` executable entry (SC-1).
 *
 * First vertical slice: a DRY-RUN driver over lib/core. It parses the argument
 * contract (args.ts), loads the template (template.ts), parses the CSV and
 * auto-detects the email column (lib/core), then prints a `DRY RUN` banner and
 * one `[i/N] would send -> <addr>  |  <merged subject>` line per row. It NEVER
 * connects to SMTP and NEVER reads a secret — live/test sending arrives in a
 * later plan; `mcp` mode is stubbed for Plan 03.
 *
 * The merge itself is delegated to lib/core.fillMessage via the exported
 * `mergeRow` helper (SC-4 — no re-implementation; the parity test asserts this).
 *
 * File reads (--csv, and --template inside template.ts) are `resolve` +
 * `statSync().isFile()` guarded (T-081-03). The password-safe argument contract
 * (T-081-01) lives in args.ts.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "./args.js";
import { loadTemplate } from "./template.js";
import {
  parseCsv,
  detectEmailColumn,
  fillMessage,
  type MessageTemplate,
  type FillRow,
} from "../../../lib/core/index.js";

const HELP = `mail-merge — CSV-driven plain-text mail merge over your own SMTP.

USAGE
  mail-merge --csv <file> --template <file> [options]

  Prints a DRY-RUN listing of every recipient that WOULD be sent. Sends nothing.

OPTIONS
  --csv <file>            Recipients CSV (header row + one row per recipient).
  --template <file>       Message template; first "Subject:" line is the subject.
  --email-column <name>   Override the auto-detected email column.
  --delay-ms <n>          Inter-send throttle in ms (default 3000).
  --send                  (later plan) send for real to every recipient.
  --test <addr>           (later plan) send the whole batch to one address.
  -h, --help              Show this help.

Note: there is deliberately NO password flag — the SMTP password is never
accepted on the command line.`;

/**
 * The one merge seam: delegate to lib/core.fillMessage. Exported so the parity
 * test can assert the CLI does not re-implement `{{column}}` substitution.
 */
export function mergeRow(tpl: MessageTemplate, row: FillRow): MessageTemplate {
  return fillMessage(tpl, row);
}

/** Stub for `mail-merge mcp` — wired in Plan 03. */
export function startMcp(): never {
  throw new Error("mcp mode is not yet wired (arrives in Plan 03)");
}

/** Read a required file with resolve + isFile guard (T-081-03). */
function readFileChecked(path: string, flag: string): Buffer {
  const resolved = resolve(path);
  let isFile = false;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    throw new Error(`${flag} path is not readable: ${path}`);
  }
  if (!isFile) {
    throw new Error(`${flag} must point to a file: ${path}`);
  }
  return readFileSync(resolved);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "mcp") {
    startMcp();
    return;
  }

  const opts = parseCliArgs(argv);

  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!opts.csv) throw new Error("--csv is required (path to the recipients CSV)");
  if (!opts.template) throw new Error("--template is required (path to the message)");

  const tpl = loadTemplate(opts.template);
  const parsed = parseCsv(readFileChecked(opts.csv, "--csv"));

  const emailColumn = opts.emailColumn ?? detectEmailColumn(parsed.columns, parsed.rows);
  if (!emailColumn) {
    throw new Error(
      "could not detect an email column — pass --email-column <name> to choose one",
    );
  }

  // This plan is a DRY-RUN driver only; live/test send lands in a later plan. Be
  // explicit when a send mode was requested so nobody thinks mail went out.
  if (opts.mode === "live") {
    console.log("NOTE: --send is not wired yet (arrives in a later plan) — showing DRY RUN.");
  } else if (opts.mode === "test") {
    console.log(
      `NOTE: --test is not wired yet (arrives in a later plan) — showing DRY RUN (would target ${opts.testAddr}).`,
    );
  }

  console.log("DRY RUN: nothing will be sent.\n");
  console.log(`${parsed.rows.length} recipient(s) loaded from ${opts.csv}`);

  const total = parsed.rows.length;
  parsed.rows.forEach((row, i) => {
    const to = opts.mode === "test" ? (opts.testAddr as string) : (row[emailColumn] ?? "");
    const merged = mergeRow(tpl, row);
    console.log(`[${i + 1}/${total}] would send -> ${to}  |  ${merged.subject}`);
  });

  console.log("\nDry run complete.");
}

// Only run when invoked directly (as the `mail-merge` bin or `tsx src/bin.ts`),
// NOT when imported by a test for `mergeRow` (which must not trigger a CLI run).
const isEntrypoint = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((e) => {
    console.error("ERROR:", (e as Error).message);
    process.exit(1);
  });
}
