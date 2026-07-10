---
phase: 02-auth-smtp-onboarding
plan: 05
subsystem: api
tags: [server-actions, nextjs, clerk, nodemailer, zod, aes-256-gcm, smtp]

# Dependency graph
requires:
  - phase: 02-02 (smtp verify engine)
    provides: verifySmtp / classifyVerifyError / smtpFormSchema
  - phase: 02-03 (userId-scoped SMTP DAL)
    provides: getSmtpConfigForUser / upsertSmtpConfig / updateFromFields
  - phase: 01 (foundation)
    provides: lib/crypto encrypt/decrypt, lib/core createSmtpTransport/verifyTransport/sendOne
provides:
  - "verifyAndSave, updateFromFields, sendTestEmail Server Actions"
  - "typed ActionResult / ActionError contract consumed by the wizard UI (02-06)"
  - "applyVerifiedConfig + sendTestVia testable orchestration seams"
affects: [02-06, 02-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server Action + non-\"use server\" injectable seam for testability"
    - "verify-then-persist (persist ONLY on clean verify; suggestion saves nothing)"
    - "verify-before-send carry-forward on the saved transport"
    - "message-only typed error returns (no raw Error, no secret)"

key-files:
  created:
    - lib/smtp/actions.ts
    - lib/smtp/actions.test.ts
  modified: []

key-decisions:
  - "Seam helpers (applyVerifiedConfig, sendTestVia) live in actions.ts as exported async fns so the must_haves key_link patterns (verifySmtp/upsertSmtpConfig/verifyTransport) and the \"use server\" directive stay in one file; they are internal helpers exported only for tests."
  - "Clerk auth() is imported lazily (dynamic import inside each wrapper) because @clerk/nextjs/server does not statically export auth under the plain tsx test runner; this keeps the module test-loadable while the wrappers still re-derive userId server-side."
  - "Per-user verify rate limit is an in-process Map (5 attempts / 60s) — durable limiting deferred to a later hardening step."

patterns-established:
  - "Non-\"use server\" injectable seam: the \"use server\" wrapper does auth + rate limit, then delegates parse/verify/persist to a plain helper that tests drive with a fake verifyFn / stub transport."
  - "Redaction contract: ActionError.raw is ALWAYS a message string; failure shapes are a closed union carrying only kind/field/raw."

requirements-completed: [SMTP-05, AUTH-02, SMTP-04]

# Metrics
duration: 12min
completed: 2026-07-11
---

# Phase 2 Plan 05: SMTP Onboarding Server Actions Summary

**Three SMTP Server Actions (verifyAndSave/updateFromFields/sendTestEmail) with a typed ActionResult contract, verify-then-persist semantics, per-user rate limiting, and message-only secret-free returns — backed by injectable seams tested against a temp DB with no live SMTP or Clerk.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments
- `verifyAndSave` runs verify-then-save atomically (D-04): persists the encrypted config and stamps `verified_at` ONLY on a clean verify; a D-05 alternate-mode suggestion saves nothing.
- `updateFromFields` saves from_addr/from_name without a verify round-trip and never touches `verified_at` (D-08).
- `sendTestEmail` decrypts the saved credential server-side, runs `verifyTransport` BEFORE `sendOne` (CLAUDE.md carry-forward), and returns a message-only typed result — never the password or a raw nodemailer error.
- Every action re-derives `userId` via Clerk `auth()` and rejects unauthenticated callers (AUTH-02 defense-in-depth); a per-user verify rate limit bounds the SSRF/abuse surface (T-2-SPAM).
- Defined the `ActionResult` / `ActionError` contract the wizard UI (02-06) consumes.

## Task Commits

Tasks 1 and 2 modify the same two files and were authored as one cohesive artifact, so they share a single commit:

1. **Task 1 (verifyAndSave + updateFromFields + seam) & Task 2 (sendTestEmail + sendTestVia)** - `750795e` (feat)

## Files Created/Modified
- `lib/smtp/actions.ts` - `"use server"` module: ActionResult/ActionError types, `applyVerifiedConfig` + `sendTestVia` seams, and the `verifyAndSave` / `updateFromFields` / `sendTestEmail` Server Actions.
- `lib/smtp/actions.test.ts` - 8 tests: verified_at semantics (save on verify, nothing on suggestion, unchanged on from-update), validation rejection, verify-before-send ordering, send-failure mapping, and redaction assertions via injected verifyFn / stub transport against a temp DB.

## Decisions Made
- **Seams in the same file:** The plan asked for a "plain (non-\"use server\") helper," but the must_haves key_link grep gates require `verifySmtp`, `upsertSmtpConfig`, and `verifyTransport` to appear in `actions.ts`, and require the `"use server"` directive there too. Keeping the seams as exported async functions inside `actions.ts` satisfies both; they are internal helpers exported only so the tests can inject a fake `verifyFn` / stub transport. All runtime exports are async functions, so the strict "use server" (all-exports-are-async-actions) constraint still holds.
- **Lazy Clerk import** (see Deviations, Rule 3).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Lazy Clerk `auth` import to keep the module test-loadable**
- **Found during:** Task 1 (running actions.test.ts)
- **Issue:** A top-level `import { auth, currentUser } from "@clerk/nextjs/server"` throws `SyntaxError: does not provide an export named 'auth'` under the plain `tsx` test runner — Clerk's server subpath resolves `auth`/`currentUser` only under the Next server runtime, so importing `./actions` (which the test does) failed at module load.
- **Fix:** Removed the top-level named import; each wrapper (`verifyAndSave`, `updateFromFields`, `sendTestEmail`) now `await import("@clerk/nextjs/server")` lazily at call time. The module loads cleanly under tsx; the wrappers still re-derive `userId` server-side under Next. Tests drive the non-auth seams, so they never invoke the lazy import.
- **Files modified:** lib/smtp/actions.ts
- **Verification:** `node --import tsx --test lib/smtp/actions.test.ts` exits 0 (8/8); `npx --no-install tsc --noEmit` exits 0.
- **Committed in:** 750795e

**2. [Rule 3 - Blocking] `npm install` in the worktree**
- **Found during:** Setup (node_modules not shared into the worktree)
- **Issue:** Dependencies were absent in the fresh worktree, so tests/tsc could not run.
- **Fix:** Ran `npm install` (existing lockfile; no package added). Explicitly permitted by the executor prompt.
- **Verification:** exit 0; subsequent test + tsc runs succeed.
- **Committed in:** n/a (no source change)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both were mechanical unblockers for the worktree/test runner; no logic or scope change.

## Issues Encountered
None beyond the deviations above.

## Verification Evidence
- `node --import tsx --test lib/smtp/actions.test.ts` → 8 pass / 0 fail.
- `npx --no-install tsc --noEmit` → exit 0.
- Secret-safety grep gate `grep -rnE 'console\.|pino' lib/smtp/actions.ts | grep -iE 'pass|password|decrypt' | grep -c .` → 0.

## Known Stubs
None — both actions are fully wired to the verify engine, DAL, crypto, and send core.

## User Setup Required
None - no external service configuration required (Clerk + SMTP wiring already established).

## Next Phase Readiness
- The `ActionResult` / `ActionError` contract is ready for the onboarding wizard UI (02-06) to consume.
- `sendTestEmail` defaults its recipient to the Clerk primary email (Open Question 1) — the wizard can pass an explicit address or rely on the default.

---
*Phase: 02-auth-smtp-onboarding*
*Completed: 2026-07-11*
