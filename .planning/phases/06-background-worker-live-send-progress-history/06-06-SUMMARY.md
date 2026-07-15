---
phase: 06-background-worker-live-send-progress-history
plan: 06
subsystem: web
tags: [csv-export, route-handler, clerk, idor, formula-injection, rfc-4180, tdd]

# Dependency graph
requires:
  - phase: 06 (plan 03 read/service layer)
    provides: getCampaignForUser IDOR guard, getSendRecordsForCampaign ownership-gated read
provides:
  - "toResultsCsv(rows) — pure RFC-4180 + formula-injection-safe results-CSV serializer"
  - "GET /campaigns/[id]/export — userId-scoped route handler streaming a per-recipient results CSV (HIST-03)"
affects: [06-05 history-ui (download link target), 06-07 verification checkpoint (IDOR manual check)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "First GET route handler: DIRECT `auth()` import from @clerk/nextjs/server (not the actions.ts lazy-import workaround)"
    - "Formula-injection guard BEFORE RFC-4180 quoting inside a single csvField() escaper"
    - "IDOR-scoped export: owner read via getCampaignForUser precedes the send_records read; NaN id → undefined → 404"

key-files:
  created:
    - lib/campaign/results-csv.ts
    - lib/campaign/results-csv.test.ts
    - app/(app)/campaigns/[id]/export/route.ts
  modified: []

key-decisions:
  - "csvField applies the formula-injection prefix FIRST, then RFC-4180 quoting, so the injected leading `'` sits inside any quoted value"
  - "sent_at renders as an ISO-8601 string (new Date(sec*1000).toISOString()); null → empty field"
  - "interrupted-prefixed errors (error starts with 'interrupted:') surface a distinct 'interrupted' status label, mirroring the UI"

patterns-established:
  - "Route-handler IDOR defense: re-derive userId via auth(), read only through the ownership-gated DAL, never a raw by-id query"

requirements-completed: [HIST-03]

# Metrics
duration: ~12min
completed: 2026-07-15
---

# Phase 6 Plan 06: Downloadable Results CSV Export Summary

**A pure, RFC-4180-correct and formula-injection-safe `toResultsCsv` serializer plus the repo's first GET route handler (`/campaigns/[id]/export`) that re-derives the Clerk userId, scopes the read to the owner, and streams a per-recipient send report (HIST-03).**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2 (Task 1 TDD RED→GREEN; Task 2 auto)
- **Files created:** 3
- **Tests:** results-csv.test.ts 9/9 green; full suite 251/251 green

## Accomplishments
- `toResultsCsv` (pure, no db/data import): header `Recipient,Status,Reason,Message ID,Sent at`, one CRLF-terminated row per send_record. Internal `csvField` neutralizes leading `= + - @ \t \r` with a `'` prefix, then RFC-4180-wraps any field containing `,`, `"`, `\r`, or `\n` with embedded quotes doubled.
- Status labeling: `error` starting with `interrupted:` → `interrupted` label, distinct from plain `failed`; `sent_at` → ISO timestamp or empty when null; reason = message-only `error ?? ""`.
- `GET /campaigns/[id]/export`: direct `auth()` import, 401 when unauthenticated, owner read via `getCampaignForUser(userId, Number(id))` → 404 on cross-tenant / bogus / NaN id, send_records read only through `getSendRecordsForCampaign`, CSV streamed with `text/csv; charset=utf-8` and `attachment; filename="campaign-{id}-results.csv"`.

## Task Commits

1. **Task 1 (RED): failing toResultsCsv tests** - `bf7fb42` (test)
2. **Task 1 (GREEN): toResultsCsv serializer** - `a4cda7e` (feat)
3. **Task 2: export route handler** - `2319fc2` (feat)

## Files Created/Modified
- `lib/campaign/results-csv.ts` - Pure `toResultsCsv` + internal `csvField`, `statusLabel`, `renderSentAt`. No `@/lib/db` or `@/lib/data` import.
- `lib/campaign/results-csv.test.ts` - 9 unit tests: comma/quote/newline quoting, `= + - @` + leading-tab neutralization, interrupted-vs-failed label, ISO/empty sent_at, empty-input header-only, reason field placement.
- `app/(app)/campaigns/[id]/export/route.ts` - IDOR-scoped GET handler streaming the results CSV.

## Decisions Made
- **Escape order:** formula-injection prefix is applied before RFC-4180 quoting inside one `csvField`, so the injected `'` lives inside any quoted value — the export route depends on this single escaper rather than two passes.
- **sent_at rendering:** ISO-8601 via `new Date(sent_at * 1000).toISOString()` (unixepoch seconds → ms); null renders as an empty field.
- **NaN handling:** rather than special-casing `Number(id)` NaN, we lean on `getCampaignForUser` returning undefined for any non-matching id (NaN never matches) → uniform 404.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None. The purity acceptance-grep (`@/lib/db|@/lib/data`) matches only the module's doc comment describing its purity, not an actual import; an import-anchored grep (`^\s*import .*@/lib/(db|data)`) confirms zero real imports.

## Threat Model Compliance
- **T-06-17 (IDOR on export route):** `auth()` re-derives the userId; the campaign is read only via `getCampaignForUser(userId, Number(id))` (owner filter → 404 on mismatch); send_records read only via the ownership-gated `getSendRecordsForCampaign`. NaN id → undefined → 404. Grep confirms no raw `db.query`/`drizzle` in the route.
- **T-06-18 (CSV formula injection):** `csvField` prefixes leading `= + - @ \t \r` with `'`; unit-tested for each payload.
- **T-06-19 (secret/raw-Error leak):** the Reason column emits the stored message-only `error` string; no config/password field is serialized (only `to_addr`, `status`, `error`, `message_id`, `sent_at` are exported).
- **T-06-SC:** no new packages.

## Verification
- `node --import tsx --test lib/campaign/results-csv.test.ts` → 9/9 green.
- `npm run build` → succeeds; `/campaigns/[id]/export` registered as a dynamic (ƒ) route.
- `npm test` full suite → 251/251 green.
- Grep gate: `grep -nE "db\.query|drizzle" app/(app)/campaigns/[id]/export/route.ts` → none.
- Purity: no `import ... from "@/lib/db"|"@/lib/data"` in results-csv.ts.

## Next Phase Readiness
- The export route is ready for the Plan 05 history UI to link to, and for the Plan 07 checkpoint's manual cross-tenant IDOR check (as user B, GET user A's export → 404).
- No blockers.

---
*Phase: 06-background-worker-live-send-progress-history*
*Completed: 2026-07-15*

## Self-Check: PASSED
All three created files exist on disk; all three task commits (bf7fb42, a4cda7e, 2319fc2) are present in git history.

## TDD Gate Compliance
Task 1 followed RED → GREEN: `test(...)` commit `bf7fb42` precedes `feat(...)` commit `a4cda7e`. RED failed with ERR_MODULE_NOT_FOUND (module absent) — no unexpected pass. No REFACTOR gate needed. Task 2 is a route handler verified by build.
