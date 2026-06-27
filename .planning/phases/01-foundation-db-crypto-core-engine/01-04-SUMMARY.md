---
phase: 01-foundation-db-crypto-core-engine
plan: 04
subsystem: core-engine
tags: [mail-merge, fill, csv, papaparse, nodemailer, smtp, send, tdd, pure-lib]
requires:
  - "01-01 (scaffolded Next.js app, tsx, node:test, tsconfig bundler resolution; papaparse/nodemailer + @types installed)"
provides:
  - "lib/core/fill.ts — fill(template,row) arbitrary {{column}} merge + fillMessage(tpl,row) over subject AND body"
  - "lib/core/csv.ts — parseCsv(text|Buffer) papaparse header parse → { columns, rows, invalidEmailCount }"
  - "lib/core/send.ts — createSmtpTransport (explicit secure) + verifyTransport + sendOne (structured result) + throttle(ms)"
  - "lib/core/index.ts — barrel re-export of fill/csv/send for Phase 5 + Phase 6"
  - "SendResult contract: { ok: true, messageId } | { ok: false, error } — the exact shape Phase 6's worker consumes"
affects:
  - "Phase 5 test-send (synchronous fill + sendOne path)"
  - "Phase 6 worker (CSV parse → per-row fill → verify → sendOne loop with configurable throttle)"
tech-stack:
  added: []
  patterns:
    - "papaparse header mode ({ header: true, skipEmptyLines: true }) replaces the CLI's split-at-first-comma (CSV-02)"
    - "fill via String.replace callback so row values containing $ are inserted literally (no regex backref surprises)"
    - "Explicit secure boolean passed verbatim to nodemailer.createTransport — NO port===465 inference (PITFALLS #3)"
    - "sendOne maps success/throw into a structured value and never throws-and-aborts (worker catch-and-continue as data)"
    - "lib/core is pure: imports only nodemailer + papaparse, no DB/crypto/Clerk/Next — reusable by web + worker"
    - "Secret-safe: send.ts performs no logging; secret fields never touch a console/structured-logger call (grep-enforced)"
key-files:
  created:
    - lib/core/fill.ts
    - lib/core/csv.ts
    - lib/core/send.ts
    - lib/core/index.ts
    - lib/core/fill.test.ts
    - lib/core/csv.test.ts
    - lib/core/send.test.ts
  modified: []
decisions:
  - "Unmatched-token rule: a {{token}} whose key is absent from the row is left INTACT (pass-through), so a misnamed merge field surfaces visibly in the preview/output rather than silently blanking — documented + tested"
  - "Token regex allows inner whitespace and [\\w.-] keys ({{ name }}, {{first.name}}) for forgiving authoring"
  - "parseCsv accepts string OR Buffer (worker reads files as bytes); strips a single leading U+FEFF BOM defensively in addition to papaparse"
  - "Email validation is RFC-lite (local@dotted.domain) and COUNTS invalid rows without dropping them — real validation is the SMTP server's job; the count is a pre-send warning signal (CSV-04 foundation)"
  - "sendOne returns messageId ?? '' so the success branch is always { ok:true, messageId:string }; error info is { message, code? } and JSON-serializable"
  - "throttle(ms) defaults to DEFAULT_DELAY_MS=3000 (carry-forward of the CLI DELAY_MS) and short-circuits on ms<=0"
metrics:
  duration: 14
  completed: 2026-06-27
  tasks: 2
  files: 7
---

# Phase 1 Plan 04: Core Mail-Merge Engine (fill / csv / send) Summary

The proven merge-and-send logic from the CLI (`send-credentials.ts`) lifted into
pure, reusable `lib/core` modules — and fixed along the way: `fill()` is
generalized from two hard-coded tokens to arbitrary `{{column}}` keys and applied
to BOTH subject and body (EDIT-03, fixes the CLI subject bug); CSV parsing swaps
the naive split-at-first-comma for papaparse with BOM/quoting/CRLF handling plus
email validation (CSV-02/CSV-04); and the SMTP send path takes an EXPLICIT
`secure` boolean (never `port===465`) and exposes `sendOne`'s structured
`{ ok, messageId }` / `{ ok, error }` contract — proven against a mock transport
with no live SMTP — delivering Phase 1 success criterion #3.

## What Was Built

### Task 1 — fill() (arbitrary columns, subject+body) + papaparse CSV parse (TDD)

`lib/core/fill.ts` — `fill(template, row)` replaces every `{{column}}` token
(optional inner whitespace, `[\w.-]` keys) with the matching row value using a
`String.prototype.replace` callback, so a value like `"$1,000"` is inserted
literally rather than interpreted as a regex backreference. An unmatched token is
left intact (documented pass-through rule). `fillMessage(tpl, row)` applies `fill`
to BOTH `subject` and `body` — the explicit fix for the CLI's
"`--test` subjects are not filled" bug (EDIT-03).

`lib/core/csv.ts` — `parseCsv(text | Buffer)` runs papaparse in header mode
(`{ header: true, skipEmptyLines: true }`), returning
`{ columns, rows, invalidEmailCount }`. It strips a leading U+FEFF BOM (PITFALLS
#12) so `{{email}}` matches, keeps quoted-comma fields as one field (the bug
papaparse fixes), handles CRLF and a blank trailing line, and validates the
`email` column with an RFC-lite check — counting (not dropping) invalid rows as a
pre-send warning signal (CONCERNS.md gap, CSV-04 foundation).

`lib/core/fill.test.ts` + `lib/core/csv.test.ts` (RED-first): 14 tests covering
arbitrary-column substitution, multi-occurrence replacement, the `$`-literal case,
the subject+body fix, BOM strip, quoted-comma integrity, CRLF, Buffer input, and
the invalid-email count (both zero and non-zero).

### Task 2 — send.ts: verify + structured sendOne + configurable throttle, explicit secure (TDD, mock transport)

`lib/core/send.ts` lifts the CLI's SMTP block as pure functions:
- `createSmtpTransport(config)` builds a nodemailer transport taking an EXPLICIT
  `secure: boolean` straight from config — there is no `port===465` inference
  anywhere (PITFALLS #3 / CONCERNS.md); the password arrives already-decrypted, so
  this module never touches `lib/crypto`.
- `verifyTransport(transport)` wraps `transport.verify()` as the pre-send
  connectivity/auth gate.
- `sendOne({ transport, from, to, subject, body })` builds the plain-text message,
  calls `sendMail`, and maps the outcome into a structured value — `{ ok: true,
  messageId }` on success, `{ ok: false, error: { message, code? } }` on
  failure — and NEVER throws-and-aborts, carrying forward the CLI's per-row
  catch-and-continue so a Phase 6 batch survives one bad recipient. This is the
  exact contract the worker consumes.
- `throttle(ms = DEFAULT_DELAY_MS)` is the configurable inter-send delay
  (carry-forward of the CLI's `DELAY_MS = 3000`), short-circuiting on `ms <= 0`.

`lib/core/index.ts` — barrel re-exporting `fill`/`csv`/`send` (values + types) for
Phase 5 (test-send) and Phase 6 (worker).

`lib/core/send.test.ts` (RED-first): 6 tests exercising the `sendOne` contract
against a duck-typed STUB transport (a plain object with `sendMail`) — success →
`{ ok: true, messageId }`, failure (rejecting `sendMail`) → `{ ok: false, error }`
without throwing, subject/body/to passthrough, `verifyTransport` delegation, and
that `throttle` waits ~the delay and `throttle(0)` returns immediately. No network.

**Security (SMTP-04 / PITFALLS #2):** `send.ts` does no logging at all — no
`console.*`/structured-logger call references any secret field. Enforced by the
plan's automated grep gate (passed).

## Verification

| Check | Result |
|-------|--------|
| `node --import tsx --test lib/core/fill.test.ts lib/core/csv.test.ts` | 14 pass / 0 fail ✓ |
| `node --import tsx --test lib/core/send.test.ts` | 6 pass / 0 fail ✓ |
| Full suite (fill+csv+send) | 20 pass / 0 fail ✓ |
| `npx --no-install tsc --noEmit` | 0 errors ✓ |
| `grep -q papaparse lib/core/csv.ts` | ✓ |
| `grep -q secure` (non-comment) + `! grep -q "=== 465"` in send.ts | explicit secure, no port inference ✓ |
| `grep -q verify lib/core/send.ts` + `test -f lib/core/index.ts` | ✓ |
| `! grep console.(log\|info\|debug\|error).*(pass\|auth\|password)` in send.ts | secret-safe ✓ |
| `! grep pino.*(pass\|auth\|password)` in send.ts | secret-safe ✓ |
| Purity: only `import nodemailer` (send) / only local re-exports (index); csv imports only papaparse; fill imports nothing | no DB/crypto/Clerk/Next ✓ |
| `send-credentials.ts` still present (legacy CLI preserved) | ✓ |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Doc-comment text broke the build and tripped the grep gates**
- **Found during:** Task 2 GREEN verification.
- **Issue:** Three problems originated in `send.ts`'s explanatory header comment,
  not in code: (a) the literal `console.*/pino` contained `*/`, which terminated
  the block comment early and produced an esbuild parse error; (b) a comment
  mentioning `port === 465` would have failed the unconditional
  `! grep -q "=== 465"` gate (the gate greps the whole file, not just code lines);
  and (c) a comment reading "pino call referencing pass/auth/password" matched the
  `! grep pino.*(pass|auth|password)` secret-leak gate.
- **Fix:** Reworded the comment to remove the `*/` sequence, the literal
  `=== 465`, and the "pino … pass/auth/password" phrasing, while preserving the
  intent (explicit-secure design, secret-safe logging). No behavior change.
- **Files modified:** lib/core/send.ts
- **Commit:** 6d16b72 (folded into GREEN).

## TDD Gate Compliance

Both tasks followed RED → GREEN (no REFACTOR commit required):

- **Task 1 RED:** `test(01-04)` `d4a3d50` — fill/csv tests fail (modules absent).
- **Task 1 GREEN:** `feat(01-04)` `6139d47` — fill.ts + csv.ts; 14/14 pass, tsc clean.
- **Task 2 RED:** `test(01-04)` `6048a31` — send mock-transport tests fail (module absent).
- **Task 2 GREEN:** `feat(01-04)` `6d16b72` — send.ts + index.ts; 6/6 pass, full gate green.

No test passed unexpectedly during any RED phase.

## Known Stubs

None. fill/csv/send are fully implemented and exercised. Deferred-by-design (NOT
stubs, and explicitly Phase 6 scope per the plan's threat register T-01-04d):
nodemailer connection pooling, `rateDelta`/`rateLimit`, and 4xx/5xx retry/backoff.
This plan delivers the configurable inter-send delay foundation only.

## Threat Surface Scan

No new security surface beyond the plan's `<threat_model>`; the implementation
realizes every `mitigate` disposition:
- **T-01-04a (SMTP password in logs):** `send.ts` does no logging; no secret field
  reaches any console/logger call — grep-gate enforced.
- **T-01-04b (wrong TLS mode):** explicit `secure` boolean passed verbatim; no
  `=== 465` inference anywhere — grep-gate enforced.
- **T-01-04c (malformed recipient address):** `parseCsv` validates the `email`
  column (RFC-lite) and returns an `invalidEmailCount` before any SMTP connection.
- **T-01-04d (rate-limit DoS):** accept (foundation) — configurable `throttle(ms)`
  carried forward; pooling/backoff is Phase 6 scope, not introduced here.

## Self-Check: PASSED

- lib/core/fill.ts — FOUND
- lib/core/csv.ts — FOUND
- lib/core/send.ts — FOUND
- lib/core/index.ts — FOUND
- lib/core/fill.test.ts — FOUND
- lib/core/csv.test.ts — FOUND
- lib/core/send.test.ts — FOUND
- Commit d4a3d50 (Task 1 RED) — FOUND
- Commit 6139d47 (Task 1 GREEN) — FOUND
- Commit 6048a31 (Task 2 RED) — FOUND
- Commit 6d16b72 (Task 2 GREEN) — FOUND
