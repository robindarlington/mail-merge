---
phase: 05-test-send-confirmation-gate
plan: 02
subsystem: api
tags: [test-send, server-actions, nodemailer, zod, smtp, chunked-batch, tdd]

# Dependency graph
requires:
  - phase: 01-foundation-db-crypto-core-engine
    provides: "lib/core pure engine (fillMessage, sendOne, createSmtpTransport, verifyTransport, throttle, parseCsv) + lib/crypto decrypt"
  - phase: 02-smtp-onboarding
    provides: "lib/data/smtp DAL (getSmtpConfigForUser, upsertSmtpConfig) + the actions/actions-core split + stubTransport test harness"
  - phase: 03-csv-upload
    provides: "lib/data/recipients DAL + lib/csv/storage readUpload (traversal-safe)"
  - phase: 04-compose-editor
    provides: "lib/data/templates DAL + lib/compose actions-core resolve->read->parse pattern + barrel rule"
provides:
  - "lib/campaign/schema.ts — shared zod validators (id/testAddress/offset) + TEST_SEND_DELAY_MS + TEST_SEND_CHUNK_SIZE"
  - "lib/campaign/actions-core.ts — sendTestBatchChunkCore (userId-accepting chunked test-send seam) + ActionError/TestSendResult union"
  - "lib/campaign/actions.ts — sendTestBatchChunk \"use server\" wrapper (auth -> delegate)"
  - "lib/campaign/index.ts — barrel exposing schema/constants + erased types (never the action)"
affects: [05-03-confirmation-gate, 05-test-send-panel-ui, 06-background-worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Chunked, client-drivable Server Action seam: bounded per-request slice + {nextOffset, done, total} cursor resolves the whole-batch-vs-proxy-timeout tension without a worker or a row cap"
    - "Inter-send throttle injected at the composition root (the \"use server\" wrapper) so the pure seam defaults to 0 and tests never sleep"

key-files:
  created:
    - lib/campaign/schema.ts
    - lib/campaign/index.ts
    - lib/campaign/actions-core.ts
    - lib/campaign/actions.ts
    - lib/campaign/actions-core.test.ts
  modified: []

key-decisions:
  - "Verify failure on chunk 0 maps to ActionError kind 'send_failed' (no verify-specific kind in this plan's closed union) and returns without sending"
  - "Inter-send throttle delay is a defaulted param on the core seam (default 0), injected as TEST_SEND_DELAY_MS by the production wrapper — keeps the injected-fake suite fast (0.58s) while production always paces at 500ms"

patterns-established:
  - "Chunked test-send cursor: rows.slice(offset, offset+CHUNK_SIZE) + nextOffset/done drives the whole batch across bounded requests"
  - "verify-once-on-chunk-0: connectivity proven on the first chunk is not re-proven on later chunks"

requirements-completed: [TEST-01]

# Metrics
duration: ~7min
completed: 2026-07-13
---

# Phase 5 Plan 02: Chunked Whole-Batch Test-Send Seam Summary

**A client-drivable, chunked test-send Server Action (`sendTestBatchChunkCore`) that redirects every per-row personalized message (subject AND body) to one test address, verifies once before sending on chunk 0, isolates per-row failures, and returns a `{nextOffset, done, total}` cursor — all proven against injected fake transports with the decrypted SMTP password contained server-side.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-13T15:17:22+02:00
- **Completed:** 2026-07-13T15:23:43Z
- **Tasks:** 3
- **Files modified:** 5 created

## Accomplishments
- `lib/campaign/schema.ts` + barrel: shared zod validators (`recipientSetIdSchema`, `templateIdSchema`, `testAddressSchema`, `chunkOffsetSchema`, `campaignIdSchema`) and the two tuning constants (`TEST_SEND_DELAY_MS=500`, `TEST_SEND_CHUNK_SIZE=10`) with the no-hard-cap chunk-size rationale documented.
- `sendTestBatchChunkCore`: validate → userId-scoped resolve (set/template/smtp) → `readUpload`+`parseCsv` → transient `decrypt` → verify-once on chunk 0 → `fillMessage`+`sendOne` per row (redirected to the one test address) → per-row-failure isolation → cursor. Reuses the Phase 1–4 primitives verbatim; no new merge/send/transport/crypto code.
- `sendTestBatchChunk` `"use server"` wrapper: auth → delegate, injecting the production throttle at the composition root.
- Full TEST-01 seam coverage (9 tests) against an injected stub transport — no real SMTP socket; suite runs in 0.58s.

## Task Commits

Each task was committed atomically:

1. **Task 1: Campaign schema constants + validators + barrel** - `e014d45` (feat)
2. **Task 2: Failing TEST-01 seam tests (RED)** - `0add4a2` (test)
3. **Task 3: Implement chunked test-send seam + wrapper (GREEN)** - `eeae08d` (feat)

_TDD plan: RED (`0add4a2`) → GREEN (`eeae08d`). No separate refactor commit was needed._

## Files Created/Modified
- `lib/campaign/schema.ts` - Shared zod validators + `TEST_SEND_DELAY_MS`/`TEST_SEND_CHUNK_SIZE`; documents the deliberate no-row-cap + per-request chunk bound.
- `lib/campaign/index.ts` - Barrel: re-exports schema/constants + erased types only (never the `"use server"` action).
- `lib/campaign/actions-core.ts` - `sendTestBatchChunkCore` seam + closed `ActionError`/`TestSendData`/`TestSendResult` union. NO `"use server"` directive.
- `lib/campaign/actions.ts` - `sendTestBatchChunk` `"use server"` wrapper (auth → delegate).
- `lib/campaign/actions-core.test.ts` - TEST-01 seam tests with an injected `stubTransport` (fill-per-row, single-address, verify-before-send, later-chunk-skips-verify, cursor, per-row-failure isolation, redaction, id validation).

## Decisions Made
- **Verify failure → `send_failed`:** this plan's closed `ActionError` union has no verify-specific kind, so a failed pre-send verify on chunk 0 is classified as `send_failed` (message-only `raw`) and returns without sending any row.
- **Throttle delay is injected, not hardcoded in the loop:** the pattern map showed `throttle(TEST_SEND_DELAY_MS)` inline, but hardcoding 500ms would make the injected-fake suite sleep ~30s of real time. The core seam takes an optional `delayMs` (default `0`) and the production wrapper injects `TEST_SEND_DELAY_MS`. Production pacing is unchanged (the wrapper is the only production entry); the test suite stays fast (0.58s). See Deviations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Parameterized the inter-send throttle delay for test-suite speed**
- **Found during:** Task 3 (implement the seam)
- **Issue:** The plan/pattern specified `await throttle(TEST_SEND_DELAY_MS)` (500ms) hardcoded between sends. With the injected fake transports the tests send real slices, so a hardcoded 500ms would make ~7 full 10-row chunks sleep ~30s of real time across the suite — wasteful and slow.
- **Fix:** Added an optional `delayMs: number = 0` param to `sendTestBatchChunkCore` (throttle is still called between sends only, never after the last row). The production `"use server"` wrapper injects `TEST_SEND_DELAY_MS` at the composition root, so real sends still pace at 500ms; tests call the core directly and default to 0.
- **Files modified:** lib/campaign/actions-core.ts, lib/campaign/actions.ts
- **Verification:** Seam suite passes in 0.58s (vs. ~30s hardcoded); production pacing preserved via the wrapper. Full `npm test` green (168 tests).
- **Committed in:** eeae08d (Task 3 commit)

**2. [Rule 3 - Blocking] Guarded `transport.close()` for the injected stub**
- **Found during:** Task 3 (implement the seam)
- **Issue:** The `finally` closes the transport, but the injected `stubTransport` (a `MailTransport`) has no `close()` method — an unconditional `transport.close()` would throw on every test.
- **Fix:** Guarded the close with `typeof closable.close === "function"`. The real nodemailer transport still closes; the stub is a no-op.
- **Files modified:** lib/campaign/actions-core.ts
- **Verification:** Seam tests pass; grep gate confirms `close()` is inside the `finally`.
- **Committed in:** eeae08d (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 blocking)
**Impact on plan:** Both are test-injection/ergonomics fixes that preserve the specified production behavior (500ms inter-send pacing, socket always closed). No scope creep; the seam contract and security properties match the plan exactly.

## Issues Encountered
- The worktree had no `node_modules` and no `drizzle`-independent tooling; symlinked `node_modules` from the main checkout (never staged — it is gitignored) to run `tsx`/`tsc`/`npm test`.
- The `grep -L "use server"` gate false-negatives because the phrase appears in `actions-core.ts` explanatory comments; verified precisely that no `"use server"` directive statement exists (first line is a JSDoc block, `grep '^"use server"'` empty).

## User Setup Required
None - no external service configuration required. All sends are proven against injected fakes; no live SMTP is contacted by the test suite.

## Next Phase Readiness
- The test-send seam + typed `TestSendResult` contract are ready for the confirmation-gate plan (05-03) and the test-send-panel UI to consume `sendTestBatchChunk` directly from `@/lib/campaign/actions`.
- Cursor shape (`nextOffset`/`done`/`total`) is the client-loop contract; the UI drives the whole batch across bounded requests.
- The pure send/fill/verify/throttle primitives remain reusable verbatim by the Phase 6 background worker.

## Self-Check: PASSED

All 5 created files exist on disk and all 3 task commits (`e014d45`, `0add4a2`, `eeae08d`) are present in git history. Full `npm test` suite green (168 tests), `tsc --noEmit` clean (exit 0), all grep gates pass (no `"use server"` directive in actions-core; `fillMessage`/`sendOne` present; `close()` inside `finally`; no hand-rolled merge/transport).

---
*Phase: 05-test-send-confirmation-gate*
*Completed: 2026-07-13*
