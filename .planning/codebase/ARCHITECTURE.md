<!-- refreshed: 2026-06-24 -->
# Architecture

**Analysis Date:** 2026-06-24

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                     CLI Entry Point                          │
│              `send-credentials.ts` — main()                  │
└──────┬──────────────┬───────────────────────┬───────────────┘
       │              │                       │
       ▼              ▼                       ▼
┌────────────┐ ┌────────────────┐ ┌──────────────────────────┐
│ Data Layer │ │ Template Layer │ │   SMTP Transport Layer   │
│            │ │                │ │                          │
│loadRecipients│ │ loadTemplate() │ │ nodemailer.createTransport│
│  (CSV file)│ │(email-template │ │  + transport.verify()    │
│`../PETR-   │ │    .txt)       │ │  + transport.sendMail()  │
│EMAIL.csv`  │ │                │ │                          │
└────────────┘ └───────┬────────┘ └───────────┬──────────────┘
                       │                       │
                       ▼                       │
              ┌────────────────┐               │
              │  fill()        │               │
              │ {{email}} and  │───────────────▶
              │ {{password}}   │   personalized
              │ substitution   │   message per
              └────────────────┘   recipient
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `main()` | Parses CLI args, orchestrates run modes, drives send loop | `send-credentials.ts:106` |
| `loadRecipients()` | Reads and validates CSV; splits at first comma to allow commas in passwords | `send-credentials.ts:30` |
| `loadTemplate()` | Reads `email-template.txt`; extracts subject from first line, body from remainder | `send-credentials.ts:47` |
| `fill()` | Performs `{{email}}` / `{{password}}` substitution per recipient | `send-credentials.ts:54` |
| `env()` | Reads required env vars from `.env`; throws if a required var is absent | `send-credentials.ts:58` |
| `promptHidden()` | Interactive password prompt that suppresses terminal echo | `send-credentials.ts:65` |
| Email template | Plain-text message with `Subject:` header line and `{{email}}`/`{{password}}` placeholders | `email-template.txt` |

## Pattern Overview

**Overall:** Single-file procedural script with a guarded `main()` async entry point.

**Key Characteristics:**
- No classes, no modules beyond the entry point — all logic lives in `send-credentials.ts`
- Three run modes controlled by CLI flags (`--send`, `--test <addr>`, default dry-run)
- SMTP transport is created lazily — only instantiated when a live send is actually required
- Errors propagate to `main().catch()` which prints to stderr and exits with code 1
- `DELAY_MS = 3000` throttle between sends is a compile-time constant at the top of the file

## Layers

**CLI / Orchestration Layer:**
- Purpose: Parse `process.argv`, determine run mode, call data/template loaders, drive send loop
- Location: `send-credentials.ts` — `main()` function (line 106)
- Contains: Mode flags, loop, summary output
- Depends on: All other layers
- Used by: npm scripts (`dry`, `test`, `send`)

**Data Layer:**
- Purpose: Load and validate recipient list
- Location: `send-credentials.ts` — `loadRecipients()` (line 30)
- Contains: CSV parsing (header validation, first-comma split)
- Depends on: `node:fs` `readFileSync`, hard-coded `CSV_PATH` constant
- Used by: `main()`

**Template Layer:**
- Purpose: Load email template and merge per-recipient variables
- Location: `send-credentials.ts` — `loadTemplate()` (line 47) + `fill()` (line 54)
- Contains: Subject-line extraction, body extraction, `{{placeholder}}` substitution
- Depends on: `node:fs` `readFileSync`, `email-template.txt`
- Used by: `main()`

**Transport Layer:**
- Purpose: Establish SMTP connection and deliver mail
- Location: `send-credentials.ts` — SMTP setup block inside `main()` (lines 129–144)
- Contains: `nodemailer.createTransport`, `verify()`, `sendMail()`, optional password prompt
- Depends on: `nodemailer`, env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_ADDR`)
- Used by: `main()` send loop

**Configuration Layer:**
- Purpose: Supply runtime secrets and sender identity
- Location: `.env` (gitignored); loaded by Node's `--env-file=.env` flag at process start
- Contains: SMTP credentials, sender address, optional sender display name
- Depends on: Nothing (loaded before script starts)
- Used by: `env()` helper and direct `process.env` reads

## Data Flow

### Dry Run (default — `npm run dry`)

1. Node loads `.env` via `--env-file=.env` before script starts
2. `main()` detects no `--send` / `--test` flag → `live = false`
3. `loadRecipients(CSV_PATH)` reads `../PETR-EMAIL.csv`, returns `Recipient[]`
4. `loadTemplate(TEMPLATE_PATH)` reads `email-template.txt`, returns `{ subject, body }`
5. Send loop: for each recipient, prints `would send -> <to>  (creds for <email>)` — no SMTP connection opened
6. Prints "Dry run complete."

### Test Send (`npm run test -- you@example.com`)

1–4. Same as dry run
5. `env("SMTP_HOST")` etc. are read; `promptHidden()` is called if `SMTP_PASS` is absent
6. `transport.verify()` confirms SMTP connectivity
7. Send loop: every personalized email is sent **to the single test address** (not the real recipient)
8. `DELAY_MS` pause between sends; per-send success/fail logged

### Live Send (`npm run send`)

1–6. Same as test send (SMTP verified)
7. Send loop: each personalized email is sent **to its actual recipient address**
8. `DELAY_MS` pause between sends; per-send success/fail logged
9. `transport.close()` called; final count printed

**State Management:**
- No persistent state. Everything is in-memory for the duration of one process run.
- `sent` counter is the only mutable state beyond the send loop index.

## Key Abstractions

**Recipient:**
- Purpose: Typed pair of `{ email: string; password: string }` per CSV row
- Examples: `send-credentials.ts:26` (type definition)
- Pattern: Plain TypeScript `type` alias; no class

**Template:**
- Purpose: `{ subject: string; body: string }` extracted from `email-template.txt`
- Examples: `send-credentials.ts:47` (`loadTemplate` return value)
- Pattern: Object literal returned from a pure function; never mutated

**`fill()` substitution:**
- Purpose: Produces a personalized string by replacing `{{email}}` and `{{password}}` tokens
- Examples: `send-credentials.ts:54`
- Pattern: Pure function — takes text + recipient, returns new string

## Entry Points

**npm scripts:**
- Location: `package.json` scripts (`dry`, `test`, `send`)
- Triggers: `npm run dry | test | send` from the project root
- Responsibilities: Load `.env`, invoke `send-credentials.ts` with the appropriate flag

**`main()` function:**
- Location: `send-credentials.ts:106`
- Triggers: Module evaluation (`main().catch(...)` at line 174)
- Responsibilities: Parses mode, loads data, optionally opens SMTP, runs send loop

## Architectural Constraints

- **Threading:** Single-threaded async/await event loop. No worker threads. Sends are sequential with `await` between each (plus `DELAY_MS` sleep).
- **Global state:** `CSV_PATH`, `TEMPLATE_PATH`, `DELAY_MS`, and `HELP` are module-level constants; all are read-only. `process.env` is read but never mutated.
- **Circular imports:** Not applicable — single-file project.
- **CSV path:** Hard-coded as `resolve(HERE, "..", "PETR-EMAIL.csv")` at line 22. The file must live one directory above the project root. A comment in the source ("change if your CSV moves") is the only affordance for changing this.
- **No transpilation:** Node.js runs the `.ts` file directly (Node 22+ strip-types or ts-node implied). No build step exists in `package.json`.

## Anti-Patterns

### Hard-coded CSV path outside the project

**What happens:** `CSV_PATH` is resolved to `../PETR-EMAIL.csv` — a file outside the repository root.
**Why it's wrong:** The CSV location is invisible to someone cloning the repo; running the script from a different working directory or in CI will silently fail with a file-not-found error.
**Do this instead:** Accept the path as a CLI argument or an env var (e.g. `CSV_PATH=./data/recipients.csv`), with a sensible default and a clear error message if the file is not found. See `send-credentials.ts:22`.

### SMTP password mutable from `promptHidden` cast hack

**What happens:** `rl as unknown as { _writeToOutput: ... }` uses an internal `readline` API to suppress echo.
**Why it's wrong:** `_writeToOutput` is an undocumented private method that could change or be removed in a Node.js minor release.
**Do this instead:** Use `process.stdin.setRawMode` or a dedicated library such as `@inquirer/password` for secure terminal input. See `send-credentials.ts:69`.

## Error Handling

**Strategy:** Throw-early with descriptive messages; all errors bubble to `main().catch()`.

**Patterns:**
- Validation errors in `loadRecipients` and `loadTemplate` throw `Error` with a human-readable message pointing to the problematic row or file.
- `env()` throws immediately if a required var is missing, preventing any send attempt.
- Per-recipient send failures are caught inline (lines 152–163) and logged without stopping the loop — the overall process does not exit on a single send failure.
- Fatal errors exit with `process.exit(1)` after printing to `stderr`.

## Cross-Cutting Concerns

**Logging:** Plain `console.log` / `console.error` — no structured logging library. One line per recipient, prefixed with `[i/total]`.
**Validation:** Inline in each loader function. CSV and template are validated at startup before any send begins.
**Authentication:** SMTP credentials come from `.env` (never committed). `transport.verify()` confirms credentials before the send loop starts.

---

*Architecture analysis: 2026-06-24*
