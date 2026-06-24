# Codebase Structure

**Analysis Date:** 2026-06-24

## Directory Layout

```
mail-merge/
├── send-credentials.ts   # Single entry point — all logic lives here
├── email-template.txt    # Plain-text email body with Subject: header line
├── package.json          # npm scripts (dry / test / send) + nodemailer dependency
├── package-lock.json     # Dependency lockfile (committed)
├── .env                  # SMTP secrets — gitignored, never committed
├── .gitignore            # Ignores node_modules/ and .env
├── node_modules/         # Installed dependencies (nodemailer)
└── .planning/
    └── codebase/         # GSD codebase map documents
```

**Note:** The CSV data file (`PETR-EMAIL.csv`) lives **outside** this directory at `../PETR-EMAIL.csv`. It is not part of the repository.

## Directory Purposes

**Project root (`mail-merge/`):**
- Purpose: Everything. This is a flat, single-file project with no subdirectory structure.
- Contains: Source file, template, npm config, secrets config
- Key files: `send-credentials.ts`, `email-template.txt`, `package.json`, `.env`

**`node_modules/`:**
- Purpose: Installed npm packages
- Contains: `nodemailer` and its dependencies
- Generated: Yes
- Committed: No

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents consumed by `/gsd:plan-phase` and `/gsd:execute-phase`
- Contains: ARCHITECTURE.md, STRUCTURE.md
- Generated: Yes (by GSD tooling)
- Committed: Optional

## Key File Locations

**Entry Point:**
- `send-credentials.ts`: The entire program. Contains all functions, the `main()` orchestrator, and the `main().catch()` invocation at line 174.

**Configuration:**
- `package.json`: Defines the three npm run scripts (`dry`, `test`, `send`) and the single runtime dependency (`nodemailer ^6.9.14`).
- `.env`: SMTP credentials and sender identity loaded at process start via `--env-file=.env`. See required variables below.

**Email Content:**
- `email-template.txt`: Editable plain-text template. First line must be `Subject: <text>`. Body follows after a blank line. Supports `{{email}}` and `{{password}}` placeholders.

**Recipient Data (external):**
- `../PETR-EMAIL.csv`: CSV file one level above the project root. Required columns: `email,password` (header row). Passwords may contain commas — the parser splits at the first comma only.

## Naming Conventions

**Files:**
- Kebab-case for multi-word names: `send-credentials.ts`, `email-template.txt`
- Extensions match actual content: `.ts` for TypeScript source, `.txt` for plain-text template

**Functions:**
- camelCase verbs: `loadRecipients`, `loadTemplate`, `fill`, `env`, `promptHidden`, `main`

**Constants:**
- SCREAMING_SNAKE_CASE for module-level constants: `HERE`, `CSV_PATH`, `TEMPLATE_PATH`, `DELAY_MS`, `HELP`

**Types:**
- PascalCase: `Recipient`

**Environment Variables:**
- SCREAMING_SNAKE_CASE with domain prefix: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_ADDR`, `FROM_NAME`

## Where to Add New Code

**New email template:**
- Edit `email-template.txt` directly. Keep the `Subject: ...` line as the first line. Add new `{{placeholder}}` tokens here and update `fill()` in `send-credentials.ts` to replace them.

**New recipient fields (e.g., display name):**
- Extend the `Recipient` type at `send-credentials.ts:26`
- Update `loadRecipients()` at `send-credentials.ts:30` to parse the new column
- Update `fill()` at `send-credentials.ts:54` to substitute the new placeholder

**New run mode:**
- Add a CLI flag check in `main()` at `send-credentials.ts:106`
- Add a corresponding npm script in `package.json` scripts block

**New SMTP option (e.g., HTML email, attachments):**
- Extend the `transport.sendMail()` call inside the send loop at `send-credentials.ts:153`

**Utilities:**
- This project has no utilities directory. For a project of this size, add helper functions directly in `send-credentials.ts` above `main()`, following the existing camelCase function naming pattern.

## Special Directories

**`.planning/`:**
- Purpose: GSD planning and codebase documentation
- Generated: Yes
- Committed: Optional (useful if team uses GSD tooling)

**`node_modules/`:**
- Purpose: Installed npm dependencies
- Generated: Yes (via `npm install`)
- Committed: No (listed in `.gitignore`)

## Required Environment Variables

Set these in `.env` (copy from `.env.example` if it exists):

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | Yes (live only) | SMTP server hostname |
| `SMTP_PORT` | Yes (live only) | SMTP port (465 for SSL, 587 for STARTTLS) |
| `SMTP_USER` | Yes (live only) | SMTP login username |
| `SMTP_PASS` | No | SMTP password — prompted interactively if absent |
| `FROM_ADDR` | Yes (live only) | Sender email address |
| `FROM_NAME` | No | Sender display name (defaults to "Service Informatique") |

---

*Structure analysis: 2026-06-24*
