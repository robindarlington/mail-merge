# External Integrations

**Analysis Date:** 2026-06-24

## APIs & External Services

**Email Delivery:**
- SMTP server (any provider) — sends personalized credential emails to each recipient
  - SDK/Client: `nodemailer` 6.10.1 (`node_modules/nodemailer`)
  - Auth: `SMTP_USER` + `SMTP_PASS` env vars (password may be prompted interactively if `SMTP_PASS` is absent)
  - Connection: `SMTP_HOST` + `SMTP_PORT` env vars; TLS mode auto-selected (port 465 = implicit SSL, port 587 = STARTTLS)
  - Implementation: `send-credentials.ts` lines 129–144 (`nodemailer.createTransport` + `transport.verify()`)
  - Webmail referenced in template: `https://ex2.mail.ovh.net` (OVH — this is a destination URL in the email body, not an API the script calls)

## Data Storage

**Databases:**
- None

**File Storage:**
- Local filesystem only
  - Input CSV: `../PETR-EMAIL.csv` (read once at startup via `readFileSync`)
  - Email template: `email-template.txt` (read once at startup via `readFileSync`)

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- None (no user auth layer — script is run locally by an operator)
- SMTP authentication only: credentials passed to `nodemailer.createTransport({ auth: { user, pass } })`
- SMTP connection is verified before any mail is sent (`transport.verify()`)

## Monitoring & Observability

**Error Tracking:**
- None — errors are caught and logged to `console.error`; process exits with code 1 on fatal errors

**Logs:**
- `console.log` to stdout: one line per recipient indicating send success or failure
- Format: `[i/total] sent -> TO  (creds for ORIGINAL_EMAIL)` or `[i/total] FAILED -> TO: error message`

## CI/CD & Deployment

**Hosting:**
- Not applicable — local CLI tool, run on operator's machine

**CI Pipeline:**
- None

## Environment Configuration

**Required env vars (for live send):**
- `SMTP_HOST` — SMTP server hostname
- `SMTP_PORT` — SMTP port (typically 465 or 587)
- `SMTP_USER` — SMTP login username
- `FROM_ADDR` — Sender email address

**Optional env vars:**
- `SMTP_PASS` — SMTP password (prompted securely at runtime if omitted)
- `FROM_NAME` — Sender display name (defaults to `"Service Informatique"`)

**Secrets location:**
- `.env` file at project root (git-ignored via `.gitignore`)
- `SMTP_PASS` may alternatively be entered interactively — it is never written to disk by the script

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None (SMTP is a push protocol; no HTTP webhooks used)

## Rate Limiting

- Script enforces a 3000 ms delay between sends (`DELAY_MS = 3000`) to stay within SMTP server limits
- Configurable by editing the constant in `send-credentials.ts` line 24

---

*Integration audit: 2026-06-24*
