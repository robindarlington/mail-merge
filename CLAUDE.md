<!-- GSD:project-start source:PROJECT.md -->
## Project

**Mail Merge Web App**

A multi-tenant web application for CSV-driven email mail merge. A signed-in user
onboards their own SMTP server and sender details (validated as functional during
onboarding), uploads a CSV, composes a plain-text email in an editor with
autocomplete merge-fields drawn from the CSV's columns, previews and test-sends
the merge, then fires a background batch that sends one personalized email per row
using their own SMTP — with live progress and a saved record of what happened.

It grows out of an existing single-file Node.js CLI script (`send-credentials.ts`)
that already performs the core merge-and-send logic for a credential-delivery use
case. This project generalizes that logic into a self-serve web product.

**Core Value:** A signed-in user can reliably send a personalized email to every row of their CSV,
using their own validated SMTP, with confidence (preview + test-send) and a record
of exactly what was sent and to whom.

### Constraints

- **Tech stack**: Next.js (React, full-stack) + Clerk auth + Tailwind CSS + shadcn/ui — Clerk and shadcn are React-first; Next.js keeps both first-class while reusing the existing nodemailer logic in Node.
- **Backend**: SQLite — keep it simple; adopt PayloadCMS only if a real CMS need appears.
- **Background sending**: Persistent Node worker + lightweight queue (optional Redis) — required for reliable medium-scale sends with live progress on a persistent VPS host.
- **Email transport**: nodemailer over each user's own SMTP (BYO SMTP) — reuses proven CLI transport logic; no shared sending infrastructure.
- **Email format**: Plain text only — WYSIWYG-style editor is for merge-field autocomplete + live preview, not rich formatting.
- **Security**: Per-user SMTP credentials encrypted at rest; SMTP password never committed or logged; carry forward `transport.verify()` before any send.
- **Deployment**: Coolify on VPS (containerized) — informs how the worker, web app, and SQLite volume are packaged.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript - `send-credentials.ts` (single source file; executed directly via Node.js native TS support)
- None
## Runtime
- Node.js v24.9.0 (confirmed on host)
- `package.json` specifies `"type": "module"` — project runs as ESM
- npm 11.12.1
- Lockfile: `package-lock.json` present (lockfileVersion 3)
## Frameworks
- None — plain Node.js script, no web framework
- No dedicated test framework. "Test" mode is a built-in CLI flag (`--test ADDR`) that redirects all sends to a single preview address.
- No build step. Node.js executes `send-credentials.ts` directly via `node --env-file=.env send-credentials.ts` (Node 22+ native TypeScript execution).
## Key Dependencies
- `nodemailer` 6.10.1 — SMTP transport; handles connection, auth, and `sendMail`. Only runtime dependency.
- `@types/nodemailer` 6.4.24 (devDependency) — TypeScript types for nodemailer
- `@types/node` 26.0.0 (devDependency, pulled in transitively) — Node.js built-in type definitions
- `undici-types` 8.3.0 (devDependency, transitive) — required by `@types/node`
## Configuration
- Loaded via Node.js `--env-file=.env` flag (no dotenv package needed)
- `.env` file present at project root (contents secret — never print)
- Key env vars consumed in `send-credentials.ts`:
- No build config files (no tsconfig.json, no bundler config)
## NPM Scripts
## Data Files
## Platform Requirements
- Node.js >= 22 (required for native `--env-file` flag and direct TypeScript execution)
- npm >= 8
- Command-line only; no server process or daemon
- SMTP credentials in `.env`
- CSV file at `../PETR-EMAIL.csv` relative to project root
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- Single kebab-case file for the main script: `send-credentials.ts`
- Template file uses kebab-case: `email-template.txt`
- camelCase for all functions: `loadRecipients`, `loadTemplate`, `fill`, `env`, `promptHidden`, `main`
- Names are verb-first and descriptive of what they do
- camelCase for local variables: `fromName`, `fromAddr`, `testAddr`, `testIdx`
- SCREAMING_SNAKE_CASE for module-level constants: `HERE`, `CSV_PATH`, `TEMPLATE_PATH`, `DELAY_MS`
- Short, contextual names in tight loops: `r` for recipient, `i` for index, `l` for line
- PascalCase for type aliases: `Recipient`
- Inline type annotations on function parameters and return types
## Code Style
- No formatter config file detected (no `.prettierrc`, `.eslintrc`, or `biome.json`)
- Consistent 2-space indentation throughout `send-credentials.ts`
- Trailing commas in multi-line object/array literals
- Double quotes for strings
- Semicolons present
- No linter configured
- No `tsconfig.json` — the script runs directly via `node send-credentials.ts` using Node.js 22+ native TypeScript support (type stripping)
- Type assertions used sparingly: `(e as Error).message` for caught errors, `rl as unknown as { ... }` for unsafe internal readline API access
- `type` keyword used for object shapes (`type Recipient`)
## Import Organization
- None — project has a single file with no internal imports
- ESM (`"type": "module"` in `package.json`)
- Bare `import` statements, no `require()`
## Error Handling
- Synchronous functions throw `new Error(message)` with descriptive messages that include context (e.g., the bad value or row number)
- The top-level `main()` call uses `.catch()` to print `ERROR: <message>` to stderr and exit with code 1
- Inside the send loop, individual send failures are caught per-recipient with `try/catch` so one failure does not abort the batch; errors are logged to stdout with a `FAILED ->` prefix
- Environment variable access is centralized in `env(name, required)` which throws on missing required vars
## Logging
- Structured prefix tags for progress: `[1/42] sent -> addr`
- Mode banners printed at startup: `DRY RUN:`, `TEST mode:`, `LIVE mode:`
- `console.error` used only for fatal top-level errors
- No timestamps or log levels
## Comments
- File-level JSDoc block at top of `send-credentials.ts` explains purpose and all run commands
- Single-line `/** ... */` JSDoc on every exported/top-level function explaining its contract
- Inline comments for non-obvious decisions (e.g., `// 465 = implicit SSL; 587 uses STARTTLS automatically`, `// hide everything typed after the prompt is shown`)
- Constants annotated inline: `const DELAY_MS = 3000; // pause between sends...`
## Function Design
- Pure functions return typed values: `Recipient[]`, `{ subject: string; body: string }`, `string`
- Async functions return `Promise<string>` or `Promise<void>`
- No untyped `any` returns
## Module Design
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
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
- No classes, no modules beyond the entry point — all logic lives in `send-credentials.ts`
- Three run modes controlled by CLI flags (`--send`, `--test <addr>`, default dry-run)
- SMTP transport is created lazily — only instantiated when a live send is actually required
- Errors propagate to `main().catch()` which prints to stderr and exits with code 1
- `DELAY_MS = 3000` throttle between sends is a compile-time constant at the top of the file
## Layers
- Purpose: Parse `process.argv`, determine run mode, call data/template loaders, drive send loop
- Location: `send-credentials.ts` — `main()` function (line 106)
- Contains: Mode flags, loop, summary output
- Depends on: All other layers
- Used by: npm scripts (`dry`, `test`, `send`)
- Purpose: Load and validate recipient list
- Location: `send-credentials.ts` — `loadRecipients()` (line 30)
- Contains: CSV parsing (header validation, first-comma split)
- Depends on: `node:fs` `readFileSync`, hard-coded `CSV_PATH` constant
- Used by: `main()`
- Purpose: Load email template and merge per-recipient variables
- Location: `send-credentials.ts` — `loadTemplate()` (line 47) + `fill()` (line 54)
- Contains: Subject-line extraction, body extraction, `{{placeholder}}` substitution
- Depends on: `node:fs` `readFileSync`, `email-template.txt`
- Used by: `main()`
- Purpose: Establish SMTP connection and deliver mail
- Location: `send-credentials.ts` — SMTP setup block inside `main()` (lines 129–144)
- Contains: `nodemailer.createTransport`, `verify()`, `sendMail()`, optional password prompt
- Depends on: `nodemailer`, env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_ADDR`)
- Used by: `main()` send loop
- Purpose: Supply runtime secrets and sender identity
- Location: `.env` (gitignored); loaded by Node's `--env-file=.env` flag at process start
- Contains: SMTP credentials, sender address, optional sender display name
- Depends on: Nothing (loaded before script starts)
- Used by: `env()` helper and direct `process.env` reads
## Data Flow
### Dry Run (default — `npm run dry`)
### Test Send (`npm run test -- you@example.com`)
### Live Send (`npm run send`)
- No persistent state. Everything is in-memory for the duration of one process run.
- `sent` counter is the only mutable state beyond the send loop index.
## Key Abstractions
- Purpose: Typed pair of `{ email: string; password: string }` per CSV row
- Examples: `send-credentials.ts:26` (type definition)
- Pattern: Plain TypeScript `type` alias; no class
- Purpose: `{ subject: string; body: string }` extracted from `email-template.txt`
- Examples: `send-credentials.ts:47` (`loadTemplate` return value)
- Pattern: Object literal returned from a pure function; never mutated
- Purpose: Produces a personalized string by replacing `{{email}}` and `{{password}}` tokens
- Examples: `send-credentials.ts:54`
- Pattern: Pure function — takes text + recipient, returns new string
## Entry Points
- Location: `package.json` scripts (`dry`, `test`, `send`)
- Triggers: `npm run dry | test | send` from the project root
- Responsibilities: Load `.env`, invoke `send-credentials.ts` with the appropriate flag
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
### SMTP password mutable from `promptHidden` cast hack
## Error Handling
- Validation errors in `loadRecipients` and `loadTemplate` throw `Error` with a human-readable message pointing to the problematic row or file.
- `env()` throws immediately if a required var is missing, preventing any send attempt.
- Per-recipient send failures are caught inline (lines 152–163) and logged without stopping the loop — the overall process does not exit on a single send failure.
- Fatal errors exit with `process.exit(1)` after printing to `stderr`.
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
