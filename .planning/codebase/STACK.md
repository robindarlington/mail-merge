# Technology Stack

**Analysis Date:** 2026-06-24

## Languages

**Primary:**
- TypeScript - `send-credentials.ts` (single source file; executed directly via Node.js native TS support)

**Secondary:**
- None

## Runtime

**Environment:**
- Node.js v24.9.0 (confirmed on host)
- `package.json` specifies `"type": "module"` — project runs as ESM

**Package Manager:**
- npm 11.12.1
- Lockfile: `package-lock.json` present (lockfileVersion 3)

## Frameworks

**Core:**
- None — plain Node.js script, no web framework

**Testing:**
- No dedicated test framework. "Test" mode is a built-in CLI flag (`--test ADDR`) that redirects all sends to a single preview address.

**Build/Dev:**
- No build step. Node.js executes `send-credentials.ts` directly via `node --env-file=.env send-credentials.ts` (Node 22+ native TypeScript execution).

## Key Dependencies

**Critical:**
- `nodemailer` 6.10.1 — SMTP transport; handles connection, auth, and `sendMail`. Only runtime dependency.

**Infrastructure:**
- `@types/nodemailer` 6.4.24 (devDependency) — TypeScript types for nodemailer
- `@types/node` 26.0.0 (devDependency, pulled in transitively) — Node.js built-in type definitions
- `undici-types` 8.3.0 (devDependency, transitive) — required by `@types/node`

## Configuration

**Environment:**
- Loaded via Node.js `--env-file=.env` flag (no dotenv package needed)
- `.env` file present at project root (contents secret — never print)
- Key env vars consumed in `send-credentials.ts`:
  - `SMTP_HOST` — SMTP server hostname (required for live send)
  - `SMTP_PORT` — SMTP port number; 465 = implicit SSL, 587 = STARTTLS (required for live send)
  - `SMTP_USER` — SMTP login username (required for live send)
  - `SMTP_PASS` — SMTP login password (optional; script prompts securely at runtime if absent)
  - `FROM_ADDR` — Sender email address (required for live send)
  - `FROM_NAME` — Sender display name (optional; defaults to `"Service Informatique"`)

**Build:**
- No build config files (no tsconfig.json, no bundler config)

## NPM Scripts

```bash
npm run dry          # DRY RUN: prints what would be sent, sends nothing
npm run test -- ADDR # Sends entire batch to a single address for preview
npm run send         # LIVE SEND: sends to every recipient in the CSV
```

Equivalent direct invocation: `node --env-file=.env send-credentials.ts [--send | --test ADDR | --help]`

## Data Files

**Input CSV:** `../PETR-EMAIL.csv` (one level up from project root) — two-column: `email,password`
**Email template:** `email-template.txt` — first line must be `Subject: ...`, remainder is plain-text body with `{{email}}` and `{{password}}` placeholders

## Platform Requirements

**Development:**
- Node.js >= 22 (required for native `--env-file` flag and direct TypeScript execution)
- npm >= 8

**Production:**
- Command-line only; no server process or daemon
- SMTP credentials in `.env`
- CSV file at `../PETR-EMAIL.csv` relative to project root

---

*Stack analysis: 2026-06-24*
