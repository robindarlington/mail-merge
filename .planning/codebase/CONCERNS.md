# Codebase Concerns

**Analysis Date:** 2026-06-24

---

## Tech Debt

**Hardcoded CSV path outside the repository:**
- Issue: `CSV_PATH` resolves to `../PETR-EMAIL.csv` (one directory above the project root), making the script non-portable and silently broken on any machine where that file does not exist at that exact path.
- Files: `send-credentials.ts` line 22
- Impact: The script throws a raw `readFileSync` ENOENT error with no helpful guidance; there is no existence check before reading. A new operator has no indication where to place the file.
- Fix approach: Accept the CSV path as a CLI argument (e.g., `--csv <path>`) with a clear usage error if omitted, or document the expected relative path in a README and add an existence check with a descriptive error message.

**No `.env.example` committed:**
- Issue: The script documents that SMTP config lives in `.env`, but no `.env.example` template is committed to the repository. The `.gitignore` correctly excludes `.env`, so a new operator has no reference for required variable names.
- Files: `.gitignore`, `package.json` (script docs reference `.env.example`)
- Impact: First-time setup will silently fail at `env()` calls with unhelpful "Missing env var X" errors one by one, rather than failing fast with a complete list.
- Fix approach: Commit a `.env.example` file listing all required variable names with placeholder values (not real secrets).

**No Node.js version pin:**
- Issue: There is no `.nvmrc`, `.node-version`, or `engines` field in `package.json`. The `--env-file` flag used in all npm scripts requires Node.js 20.6+. The script also runs as a native TypeScript file via Node.js 22+ (`node send-credentials.ts`), which requires 22.6+ for native TS strip-types support.
- Files: `package.json`
- Impact: Silently broken on Node.js < 20.6 (the `--env-file` flag is silently ignored, so no env vars are loaded and the script throws `Missing env var SMTP_HOST` with no explanation).
- Fix approach: Add `"engines": { "node": ">=22.6" }` to `package.json` and a `.nvmrc` file.

**`_writeToOutput` monkey-patch on readline internals:**
- Issue: `promptHidden` suppresses terminal echo by overriding the private `_writeToOutput` method on the readline interface, cast through `as unknown as` to bypass TypeScript safety.
- Files: `send-credentials.ts` lines 69–77
- Impact: This is an undocumented internal API. Any Node.js minor release may rename or remove it, breaking the hidden-password prompt silently (it would echo the password to the terminal instead of erroring).
- Fix approach: Replace with a dedicated package such as `read` (npm) that handles hidden input portably, or use `process.stdin.setRawMode` directly.

---

## Security Considerations

**Plaintext passwords in CSV file:**
- Risk: The CSV at `../PETR-EMAIL.csv` contains recipient email addresses paired with plaintext passwords. If the CSV is stored anywhere accessible (shared drive, cloud storage, email attachment used to deliver it), those credentials are exposed in bulk.
- Files: `send-credentials.ts` lines 30–44 (CSV reader)
- Current mitigation: The CSV path is outside the repository directory, so it is not committed. The `.gitignore` does not explicitly exclude it, but it resides in the parent directory.
- Recommendations: Add explicit documentation (or a README) warning never to commit or email the CSV. Consider shredding or encrypting the file after the merge completes. The `.gitignore` should also cover `../*.csv` if the file ever migrates inside the project root.

**Passwords transmitted in plaintext email body:**
- Risk: The `fill()` function interpolates `{{password}}` directly into the plain-text email body. Email is not end-to-end encrypted; the password is visible to any mail server in the relay chain, the recipient's mail provider, and anyone with access to the recipient's inbox.
- Files: `send-credentials.ts` lines 54–56, `email-template.txt` line 7
- Current mitigation: None — this is the intended design of the script.
- Recommendations: This is an accepted risk for the use case (initial credential delivery), but it should be documented explicitly. Recipients should be instructed to change their password immediately after first login.

**SMTP password in environment / process memory:**
- Risk: `SMTP_PASS` is read from `process.env` or prompted at runtime. Once loaded, it lives in the process environment for the full duration of the script. The `.env` file itself is excluded from git, but there is no check that file permissions are appropriately restrictive.
- Files: `send-credentials.ts` lines 133–135
- Current mitigation: `.gitignore` excludes `.env`. The prompt path avoids storing the password in the file at all.
- Recommendations: No code change needed; operator should ensure `.env` file permissions are `600` (`chmod 600 .env`).

**No input validation on recipient email addresses:**
- Risk: `loadRecipients` trims and checks for non-empty values but does not validate that the email field is a syntactically valid address. A malformed or injection-style value would be passed directly to nodemailer's `to` field.
- Files: `send-credentials.ts` lines 36–43
- Current mitigation: nodemailer performs its own basic validation and will reject obviously malformed addresses at send time.
- Recommendations: Add a simple regex or use the `validator` package to validate addresses at load time, so problems are caught before any SMTP connection is made.

---

## Known Bugs

**`--test` mode subjects are not filled per-recipient:**
- Symptoms: In `--test` mode, all emails are routed to the test address, but the subject line is the raw template string (no `{{email}}`/`{{password}}` substitution on the subject). `fill()` is only applied to the body (`tpl.body`), not to `tpl.subject`.
- Files: `send-credentials.ts` line 155 (`subject: tpl.subject`)
- Trigger: Any template that includes `{{email}}` in the Subject line.
- Workaround: Keep `{{email}}` and `{{password}}` out of the Subject line.

**Failure on last recipient still waits the full delay:**
- Symptoms: The `DELAY_MS` sleep is applied between every send including the final one when `i < recipients.length - 1` is correctly guarded, so this is actually fine — but the `transport.close()` on line 170 is called outside the `if (live && transport)` guard; it is called unconditionally when `transport` is undefined in dry-run mode. `nodemailer.Transporter.close()` is a no-op on undefined, but only because `transport` is guarded by the `if (transport)` inline check on line 170.
- Files: `send-credentials.ts` line 170
- Trigger: Dry-run mode (`transport` is undefined). This is actually safe at runtime due to the `if (transport)` check, but the logic is confusing and fragile.
- Workaround: None needed currently, but the guard should be inside the `live` block for clarity.

---

## Performance Bottlenecks

**Fixed 3-second inter-send delay with no configurability:**
- Problem: `DELAY_MS = 3000` is a hardcoded constant. For a small batch this is fine; for a large recipient list it becomes slow with no way to tune it.
- Files: `send-credentials.ts` line 24
- Cause: Magic constant, not exposed as an env var or CLI flag.
- Improvement path: Read from `process.env.DELAY_MS` with a default fallback, or accept a `--delay` CLI flag.

**Entire CSV loaded into memory before first send:**
- Problem: `loadRecipients` reads and parses the entire CSV synchronously before any sending begins. For very large recipient lists this can cause a memory spike and a noticeable startup delay.
- Files: `send-credentials.ts` lines 30–44
- Cause: `readFileSync` + in-memory array.
- Improvement path: For this script's expected scale (tens to hundreds of rows) this is not a practical problem. Document the scale limit (e.g., "tested up to ~500 rows").

---

## Fragile Areas

**No idempotency / resume-after-failure:**
- Files: `send-credentials.ts` lines 146–168
- Why fragile: If the script fails or is interrupted mid-batch (network drop, SMTP error, Ctrl+C), there is no record of which recipients were already sent to. Re-running `npm run send` will re-send to all recipients from the beginning, duplicating emails.
- Safe modification: Individual `sendMail` failures are caught per-row and logged, but do not abort the run — this is good. However, there is no sent-log or state file.
- Fix approach: Append each successfully sent address to a `sent.log` file. At startup, load that log and skip addresses already present. Warn the operator if a partial log is found.

**No confirmation prompt before live send:**
- Files: `send-credentials.ts` lines 146–168
- Why fragile: After SMTP verification, the script immediately starts sending to all recipients with no "Are you sure? (y/N)" prompt. A mistyped `npm run send` instead of `npm run dry` goes live immediately.
- Safe modification: The `--test` and dry-run paths are safe. Only `npm run send` is dangerous.
- Fix approach: Add an interactive confirmation prompt (show recipient count and first recipient) before the loop begins in `--send` mode.

**CSV path is relative to `__dirname` of the script, not CWD:**
- Files: `send-credentials.ts` line 22
- Why fragile: `resolve(HERE, "..", "PETR-EMAIL.csv")` always resolves relative to the script file's directory, not the directory from which the operator runs the command. This differs from typical CLI tool behavior and is surprising.
- Safe modification: This is currently consistent (always looks one directory up from the script), but moving the script changes the path.
- Fix approach: Accept path via `--csv` argument; fall back to a path relative to `process.cwd()`.

**`secure` flag inferred solely from port number:**
- Files: `send-credentials.ts` line 139
- Why fragile: `secure: port === 465` — if an operator uses a non-standard port for implicit TLS (e.g., port 993 for some configurations), the connection will attempt STARTTLS instead of implicit TLS, likely failing. Conversely, a port-465 server that uses STARTTLS will fail.
- Safe modification: `transport.verify()` will catch the mismatch before any mail is sent.
- Fix approach: Expose a `SMTP_SECURE=true|false` env var and use it explicitly.

---

## Test Coverage Gaps

**No tests of any kind:**
- What's not tested: All logic — CSV parsing, template loading, template variable substitution, env var validation, SMTP transport creation, send loop, error handling per row.
- Files: `send-credentials.ts` (entire file)
- Risk: Silent regressions in CSV parsing (especially edge cases: trailing commas, quoted fields, Windows line endings), template substitution, and error handling. A broken script discovered at send-time with real recipients is high-impact.
- Priority: High

**No test framework configured:**
- What's not tested: There is no `jest.config.*`, `vitest.config.*`, or test runner in `devDependencies`. The `"test"` npm script is repurposed as the preview-send command, not a test runner.
- Files: `package.json`
- Risk: No infrastructure for adding tests even if desired.
- Priority: Medium — for a one-shot script this may be acceptable, but the `test` script name conflict will confuse anyone expecting `npm test` to run a test suite.

---

## Missing Critical Features

**No README / operator runbook:**
- Problem: There is no README.md. Setup instructions exist only as a JSDoc comment at the top of `send-credentials.ts` and in the `HELP` constant (only visible at runtime with `--help`). There is no `.env.example`.
- Blocks: A new operator cannot set up or safely operate the script without reading the source code.

**No sent-log or audit trail:**
- Problem: The script prints per-send results to stdout but does not persist them. If the terminal is closed or the output is not captured, there is no record of which emails succeeded or failed.
- Blocks: Post-send verification, partial-batch recovery, and compliance record-keeping.

---

*Concerns audit: 2026-06-24*
