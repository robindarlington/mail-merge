---
phase: 02-auth-smtp-onboarding
plan: 02
subsystem: smtp
tags: [nodemailer, zod, smtp-server, tls, verify, ssrf, node-test]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: lib/core/send.ts createSmtpTransport + verifyTransport (single transport factory), node:test house style, lib/crypto encrypt/decrypt
provides:
  - Shared zod 4 SMTP form schema (smtpFormSchema) validated identically client + server (SMTP-01/SMTP-02)
  - Explicit-TLS contract carried through the transport (secure never port-inferred)
  - SSRF host-literal rejection (loopback/link-local/RFC1918) at the schema boundary
  - classifyVerifyError — nodemailer error → field-anchored {kind, field} (D-06)
  - verifySmtp — live verify with short onboarding timeouts + D-05 alternate-TLS-mode probe (SMTP-03)
  - lib/smtp barrel (schema, errors, verify surfaces) for the Server Action layer
affects: [02-05 verifyAndSave server action, 02-04 onboarding wizard form, 05 test-send, 06 worker]

# Tech tracking
tech-stack:
  added: [smtp-server (dev fixture), zod 4 email/coerce idioms]
  patterns:
    - "Additive extension of the single lib/core transport factory (optional timeout/requireTLS fields) — no second factory"
    - "Classifier returns a value only; raw Error never crosses outward (T-2-CRED)"
    - "verify() wrapped in try/finally that always closes the socket; short ONBOARDING_TIMEOUTS bound each attempt"
    - "Local smtp-server fixtures pin empirical failure signatures instead of trusting training-knowledge assumptions"

key-files:
  created:
    - lib/smtp/schema.ts
    - lib/smtp/errors.ts
    - lib/smtp/verify.ts
    - lib/smtp/index.ts
    - lib/smtp/schema.test.ts
    - lib/smtp/errors.test.ts
    - lib/smtp/verify.test.ts
  modified:
    - lib/core/send.ts

key-decisions:
  - "A1 resolved empirically: an implicit-TLS-vs-plaintext mismatch surfaces as ETIMEDOUT with message 'Greeting never received' (greeting timeout), NOT an SSL 'wrong version number' ESOCKET on this stack (nodemailer 9 / Node 24). The classifier's greeting-timeout→tls branch is what fires; the 'wrong version number' regex branch is retained as a defensive fallback for other servers."
  - "requireTLS:!secure hardwired in verifySmtp so STARTTLS mode cannot silently stay cleartext (T-2-TLS)"
  - "SSRF check is a literal-IP/localhost refinement for v1 (per RESEARCH A5); DNS-resolve-then-check deferred"

patterns-established:
  - "lib/smtp composes lib/core rather than re-implementing transport code"
  - "Table-driven node:test for the error classifier; real-fixture node:test for the verify engine"

requirements-completed: [SMTP-01, SMTP-02, SMTP-03]

# Metrics
duration: 12min
completed: 2026-07-10
---

# Phase 2 Plan 02: SMTP Verification Engine Summary

**Shared zod 4 SMTP schema (with SSRF host rejection) plus a live verifySmtp engine that fails fast on short timeouts, classifies auth/connection/TLS failures to specific form fields, and auto-probes the alternate TLS mode — pinned by local smtp-server fixtures.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-10T21:44:33Z
- **Completed:** 2026-07-10T21:56:31Z
- **Tasks:** 3
- **Files modified:** 8 (7 created, 1 extended)

## Accomplishments
- Extended `lib/core/send.ts` `SmtpConfig` additively with optional `requireTLS` + four timeout fields, forwarded to nodemailer only when set — Phase-1 `send.test.ts` still green (single-factory contract preserved).
- `smtpFormSchema` (zod 4: `z.email()`, `z.coerce.number().int().min(1).max(65535)`) validates every SMTP field and rejects loopback/link-local/RFC1918 host literals (T-2-SSRF).
- `classifyVerifyError` deterministically maps `EAUTH`/SSL-handshake/greeting-timeout/`EDNS`/`ECONNECTION`/`ETIMEDOUT`/`ESOCKET` to field-anchored `{kind, field}` (D-06), proven by a 10-row table test.
- `verifySmtp` verifies with `ONBOARDING_TIMEOUTS` (10s/10s/15s/10s), always closes the socket, and on a TLS-shaped failure probes the alternate `secure` mode once, returning a `suggestion` without saving (D-05).
- `smtp-server` fixtures empirically pin the three failure classes — auth (122ms), connection-refused (<15s, actually ~3ms), and the TLS-mismatch signature (assumption A1).

## Task Commits

1. **Task 1: Extend send.ts factory + zod schema + schema test** - `19ee5c6` (feat)
2. **Task 2: Error classifier + table-driven test** - `c6aa68e` (feat)
3. **Task 3: verifySmtp + TLS auto-retry + smtp-server fixture test** - `6d48fc7` (feat)

## Files Created/Modified
- `lib/core/send.ts` - Added optional `requireTLS`/`connectionTimeout`/`greetingTimeout`/`socketTimeout`/`dnsTimeout` to `SmtpConfig`, forwarded conditionally in `createSmtpTransport`.
- `lib/smtp/schema.ts` - `smtpFormSchema` + `SmtpFormValues` + `isPrivateHostLiteral` (SSRF refinement).
- `lib/smtp/errors.ts` - `classifyVerifyError`, `VerifyErrorKind`, `VerifyErrorField` (D-06).
- `lib/smtp/verify.ts` - `verifySmtp`, `ONBOARDING_TIMEOUTS`, `VerifyOutcome` (D-04/D-05, SMTP-03).
- `lib/smtp/index.ts` - Barrel re-exporting schema/errors/verify surfaces.
- `lib/smtp/schema.test.ts` - 13 tests: field validation + private-range rejection + public-numeric allow.
- `lib/smtp/errors.test.ts` - 11 tests: table-driven classifier incl. ESOCKET-TLS-precedence.
- `lib/smtp/verify.test.ts` - 3 fixture tests: auth / connection(<15s) / tls-mismatch(A1) + D-05 suggestion.

## Assumption A1 Resolution (observed TLS-mismatch signature)
Probing an implicit-TLS-only `smtp-server` fixture with `secure:false` (plaintext client) did **not** produce an SSL "wrong version number" `ESOCKET`. On nodemailer 9 / Node 24 the plaintext client sends `EHLO` into a TLS listener, receives no valid SMTP greeting, and the attempt fails at the greeting timeout:

> `code: ETIMEDOUT`, `message: "Greeting never received"`

This is caught by the classifier's `ETIMEDOUT && /greeting/i` → `tls` branch. The `/wrong version number|ssl|tls|handshake/i` branch is retained as a defensive fallback for stacks/servers that surface the SSL-level error instead. The D-05 alternate-mode probe (retry with `secure:true`) then succeeds against the fixture, yielding `{ ok:false, kind:"tls", suggestion:"implicit" }` without saving — exactly the one-click-switch UX contract.

## Decisions Made
- Retained both TLS-detection branches (SSL-message regex + greeting-timeout) rather than narrowing to only the observed signature, so the classifier is robust across server implementations.
- Used `127.0.0.1` (not `localhost`) inside the verify fixtures — see Issues below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing node_modules in the worktree**
- **Found during:** Setup (before Task 1)
- **Issue:** node_modules is not shared into the worktree; `zod`, `smtp-server`, `tsx`, `tsc` all absent, so no test or typecheck could run.
- **Fix:** Ran `npm install` (existing lockfile, no dependency changes) inside the worktree.
- **Files modified:** none tracked (node_modules is gitignored; package-lock.json unchanged).
- **Verification:** `zod`/`smtp-server`/`tsx`/`tsc` resolve; baseline `lib/core/send.test.ts` passes.
- **Committed in:** n/a (no tracked change).

**2. [Rule 1 - Bug] Reworded two doc comments that tripped grep gates**
- **Found during:** Tasks 1 & 3 (verification gates)
- **Issue:** A comment in `schema.ts` contained the literal zod-3 idiom string and a comment in `verify.ts` contained the literal `rejectUnauthorized: false` string — both would fail the plan's acceptance grep gates despite being prose, not code.
- **Fix:** Reworded both comments to describe the anti-pattern without the literal substrings.
- **Files modified:** lib/smtp/schema.ts, lib/smtp/verify.ts
- **Verification:** `grep -c "z.string().email("` and `grep -c "rejectUnauthorized: false"` both return 0.
- **Committed in:** 19ee5c6, 6d48fc7 (task commits).

---

**Total deviations:** 2 (1 blocking env install, 1 comment/grep-gate bug)
**Impact on plan:** No scope creep. Both were necessary to run tests and pass the plan's own verification gates.

## Issues Encountered
- **`localhost` fixture latency (~10s per verify):** The verify fixtures initially used `host: "localhost"`. On this dual-stack host nodemailer attempts IPv6 `::1` first and stalls ~10s on the greeting before falling back to IPv4, making the auth test take ~11s. Root-caused via an isolated timing probe (127.0.0.1 → 113ms vs localhost → 10.1s) and fixed by pointing the fixtures at the `127.0.0.1` literal. This is a test-fixture artifact only — real users enter real hostnames, and the schema rejects such literals (the test calls `verifySmtp` directly, bypassing the schema). The TLS-mismatch test still takes ~10s because that IS the greeting-timeout detection mechanism (A1), which is inherent and bounded <15s.
- **Self-signed fixture certs:** The implicit-TLS fixtures present a throwaway self-signed cert. Since `verifySmtp` correctly never disables cert verification, the test process sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (test-only, does not touch lib code) so the fixture handshake completes. Production keeps nodemailer's secure defaults.

## Verification Results
- Full new suite (`schema.test.ts errors.test.ts verify.test.ts`): 27 tests, 27 pass.
- Phase-1 regression (`lib/core/send.test.ts`): 6 pass.
- Secret-safety grep gate on `lib/smtp`: 0 matches.
- `rejectUnauthorized: false` in `verify.ts`: 0.
- `npx tsc --noEmit`: exit 0.

## Threat Flags
None — no security surface introduced beyond the plan's threat_model (all of T-2-TLS / T-2-MITM / T-2-SSRF / T-2-CRED mitigations implemented and grep/test-asserted).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The verify engine is ready for the 02-05 `verifyAndSave` Server Action (parse with `smtpFormSchema` → `verifySmtp` → on success `encrypt` + upsert) and for the 02-04 wizard form (shared `smtpFormSchema` resolver, field-anchored error `kind`/`field` and D-05 `suggestion` consumed by the UI copy contract).
- No blockers. Per-user rate limiting of verify attempts (T-2-SPAM, partial) remains to be applied at the Server Action layer in 02-05, as planned.

---
*Phase: 02-auth-smtp-onboarding*
*Completed: 2026-07-10*
