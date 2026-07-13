---
phase: 03-csv-upload-parsing-recipient-mapping
verified: 2026-07-13T13:30:00Z
status: passed
score: 5/5 roadmap success criteria verified; 21/21 plan-level must-have truths verified
overrides_applied: 0
---

# Phase 3: CSV Upload + Parsing + Recipient Mapping Verification Report

**Phase Goal:** A user can upload a CSV and get a correctly parsed, validated recipient set with a confirmed email column and known merge-field columns.
**Verified:** 2026-07-13
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can upload a CSV through the browser and the app parses it robustly (quoted fields, BOM stripped, Windows line endings, encoding handled) with the header row detected. | ✓ VERIFIED | `lib/core/csv.ts` uses papaparse in header mode, strips leading BOM (`stripBom`), and `lib/core/csv.test.ts` proves BOM-strip + CRLF handling. `components/recipients/csv-uploader.tsx` posts a real file to `parseUploadedCsv`. Browser UAT (03-04-SUMMARY "Browser Verification") confirms an actual 4-row fixture with a quoted comma field parses correctly end-to-end. "Encoding handled" is explicitly scoped to UTF-8+BOM+CRLF (not Windows-1252 transcoding) by RESEARCH.md Assumption A1, marked RESOLVED — a documented, non-blocking scope decision, not a gap. |
| 2 | The app auto-detects the recipient (email) column and the user can confirm or override the choice. | ✓ VERIFIED | `detectEmailColumn()` (`lib/core/csv.ts`) implements the two-stage header/content heuristic, unit-tested in `lib/core/csv.test.ts`. `csv-uploader.tsx`'s `Select` is prefilled to `detectedEmailColumn`, unset with a placeholder + disabled Save when null. Browser UAT: auto-detected `Work Email`, then override to `Name` and back, both persisted correctly. |
| 3 | The app validates recipient email addresses at upload and reports the count of invalid rows. | ✓ VERIFIED | `countInvalidEmails()` computes a per-column invalid count; `parseUploadedCsvCore` builds `invalidCounts: Record<string, number>` for every column (`lib/csv/actions-core.ts`), tested in `actions-core.test.ts` ("exposes a per-column invalidCounts map"). UI renders "{n} of {rowCount} rows…" from the server map (`csv-uploader.tsx` lines 324-338); browser UAT shows "1 of 4 rows" recomputing to "4 of 4 rows" on override. |
| 4 | Parsed recipients and detected columns are saved as a per-user recipient set (with `columns_json`, row count, storage path) that later phases read for merge fields. | ✓ VERIFIED | `createRecipientSet(userId, values)` (`lib/data/recipients.ts`) inserts `{userId, filename, columns_json, row_count, storage_path}`; `getRecipientSetForUser`/`listRecipientSetsForUser` are userId-scoped with `and(eq(id), eq(userId))` (IDOR-safe, 6-test two-tenant harness in `recipients.test.ts`). `saveRecipientSetCore` writes bytes via `writeUpload` (UUID-named, traversal-proof) then inserts the row, in that order (orphan avoidance, tested). Browser UAT confirms a real persisted row (row_count=4, correct columns_json, UUID storage_path, user filename absent from path) and a file on disk under `data/uploads/`. |
| 5 | The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there. | ✓ VERIFIED | `docker-compose.yml` sets `UPLOADS_PATH: /data/uploads` on the shared `/data` volume (grep-confirmed); `.env.example` documents the dev default. `docker compose config` parses cleanly. 03-05-SUMMARY records the human deploy checkpoint (RESOLVED, commit `e2591fc`) and the human verify checkpoint (APPROVED 2026-07-13): "a restart still shows the previously uploaded list" — durable-volume persistence proven on the actual staging URL, not simulated. |

**Score:** 5/5 roadmap success criteria verified

### Plan-Level Must-Haves (frontmatter, all 5 plans)

| Plan | Must-have truth | Status | Evidence |
|------|------------------|--------|----------|
| 03-01 | `detectEmailColumn` two-stage heuristic (header hint → content sampling >0.7) rejects substring-only columns, returns null when nothing qualifies | ✓ VERIFIED | Implemented exactly per spec in `lib/core/csv.ts`; `grep -c "const EMAIL_RE" lib/core/csv.ts` = 1 (no redeclare). |
| 03-01 | `countInvalidEmails` works over an arbitrary confirmed column, not the literal `"email"` | ✓ VERIFIED | `countInvalidEmails(rows, column)` iterates on the passed column; `parseCsv`'s own literal-`"email"` `invalidEmailCount` is untouched. |
| 03-01 | `parseCsv` signature/behavior unchanged; 9 pre-existing tests still pass | ✓ VERIFIED | Full suite 123/123 green; `lib/core/csv.test.ts` has both old and new cases. |
| 03-01 | `writeUpload` writes to `<UPLOADS_DIR>/<uuid>.csv`, never the user filename, returns relative path | ✓ VERIFIED | `lib/csv/storage.ts`: `randomUUID()` name, `writeFileSync(resolve(UPLOADS_DIR, name), bytes)`, returns `{storagePath: name}` (relative). No `file.name`/filename param anywhere in the module. |
| 03-01 | Upload zod guard rejects wrong type/oversize; `confirmColumnSchema` requires non-empty `emailColumn` | ✓ VERIFIED | `lib/csv/schema.ts` `uploadFileSchema` + `confirmColumnSchema`; both covered in `schema.test.ts`. |
| 03-01 | `npm test` runs the full lib suite via `node --import tsx` | ✓ VERIFIED | `package.json` `"test": "node --import tsx --test \"lib/**/*.test.ts\""`; ran directly, 123/123 pass. |
| 03-02 | `createRecipientSet` server-injects `userId`; caller's values type omits it | ✓ VERIFIED | `PersistableRecipientSet = Pick<NewRecipientSet, "filename"\|"columns_json"\|"row_count"\|"storage_path">`; `{ userId, ...values }` spread. |
| 03-02 | `listRecipientSetsForUser` scoped + newest-first | ✓ VERIFIED | `eq(recipient_sets.userId, userId)`, `orderBy: desc(recipient_sets.created_at)`; test-asserted. |
| 03-02 | `getRecipientSetForUser` uses `and(eq(id), eq(userId))` — no fetch-by-id-alone path (IDOR) | ✓ VERIFIED | Source-confirmed; 6-test two-tenant harness proves User B → User A id returns `undefined`. |
| 03-02 | DAL exported through `lib/data` barrel | ✓ VERIFIED | `lib/data/index.ts` re-exports `createRecipientSet`, `listRecipientSetsForUser`, `getRecipientSetForUser`. |
| 03-03 | `parseUploadedCsv` returns full `invalidCounts` map, never writes to disk | ✓ VERIFIED | `parseUploadedCsvCore` builds the map from every column; no `writeUpload`/`createRecipientSet` call in the parse path (manual read + orphan test confirm). |
| 03-03 | `saveRecipientSet` re-validates on CONFIRMED column, writes bytes only after validation, in write→insert order | ✓ VERIFIED | `saveRecipientSetCore`: schema-validate → re-guard/re-parse → row-cap → header-membership check → count → `writeUpload` → `createRecipientSet`. Test proves a too-many-rows save inserts/writes nothing. |
| 03-03 | Both actions re-derive `userId` via Clerk `auth()`; reject unauthenticated | ✓ VERIFIED | `lib/csv/actions.ts`: lazy `await import("@clerk/nextjs/server")`, `auth()`, `{ kind: "unauthenticated" }` guard on both exports. |
| 03-03 | Row cap (`MAX_ROWS`) enforced at PARSE time, not only save; misparse → `parse_error` | ✓ VERIFIED | `parseUploadedCsvCore` checks `rows.length > MAX_ROWS` before returning; test "rejects a CSV over MAX_ROWS at parse time" passes. `hasStructuralParseError` filters benign `UndetectableDelimiter` but surfaces genuine structural errors. |
| 03-03 | `next.config.ts` `bodySizeLimit` = 4mb | ✓ VERIFIED | `experimental: { serverActions: { bodySizeLimit: "4mb" } }` present. |
| 03-03 | Core seams have no `"use server"` directive; `actions.ts` exports only the two gated actions | ✓ VERIFIED | `grep -c '"use server"' lib/csv/actions-core.ts` = 0; `actions.ts` starts with `"use server"` and exports exactly `parseUploadedCsv`/`saveRecipientSet` (+ type-only re-exports). |
| 03-04 | Full upload → parse → confirm/override → save flow works in a browser, persisting a recipient set | ✓ VERIFIED | Autonomous browser UAT (03-04-SUMMARY): real Clerk test user, real upload, real override, real persisted row + file on disk. |
| 03-04 | Select prefilled to detected column; unset + Save disabled when detection is null | ✓ VERIFIED | `csv-uploader.tsx` `Select value={emailColumn}`, `Save` button `disabled={saving \|\| !emailColumn}`. |
| 03-04 | Invalid count recomputes from `invalidCounts[selectedColumn]`, never a client re-parse, never limited to sample rows | ✓ VERIFIED | Source line 289-291 reads `data.invalidCounts[emailColumn]`; sample rows are a separate, clearly-commented cosmetic-only path. Browser UAT proves the recompute live. |
| 03-04 | Invalid count renders neutral (not destructive); blocking errors render destructive | ✓ VERIFIED | `grep -c "text-destructive" components/recipients/csv-uploader.tsx` on the count line = 0; count line uses `text-muted-foreground`/`text-success`; blocking errors use `Alert variant="destructive"`. |
| 03-04 | Upload/Save buttons disable in-flight with correct copy | ✓ VERIFIED | `disabled={parsing}` / `disabled={saving}`; "Reading your file…" / "Saving…" strings present with `Loader2`. |
| 03-04 | /recipients shows empty-state vs list; sidebar nav slot exists | ✓ VERIFIED | `page.tsx` conditional on `sets.length === 0`; `components/app-sidebar.tsx` `NAV_ITEMS` includes `{ title: "Recipients", href: "/recipients", icon: Users }`. |
| 03-05 | `docker-compose.yml` injects `UPLOADS_PATH=/data/uploads` on the shared volume | ✓ VERIFIED | Grep-confirmed at `docker-compose.yml:47`. |
| 03-05 | `.env.example` documents `UPLOADS_PATH` with dev-default | ✓ VERIFIED | `.env.example:17` `UPLOADS_PATH=./data/uploads` with mirrored comment. |
| 03-05 | Staging round-trip works; survives container restart | ✓ VERIFIED | Human checkpoint APPROVED, explicit restart-persistence confirmation recorded in 03-05-SUMMARY. |
| 03-05 | `storage_path` stays relative | ✓ VERIFIED | `writeUpload` returns only `${randomUUID()}.csv` (no directory prefix); unchanged since 03-01. |

**Score:** 21/21 plan-level must-have truths verified across all 5 plans.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/core/csv.ts` | `detectEmailColumn` + `countInvalidEmails`, additive to `parseCsv` | ✓ VERIFIED | Present, substantive, wired (imported by actions-core via `@/lib/core` barrel), tests pass |
| `lib/csv/schema.ts` | `MAX_UPLOAD_BYTES`, `MAX_ROWS`, `uploadFileSchema`, `confirmColumnSchema` | ✓ VERIFIED | Present, substantive, wired into `actions-core.ts` and client `csv-uploader.tsx` |
| `lib/csv/storage.ts` | `writeUpload` UUID-named traversal-proof writer | ✓ VERIFIED | Present, substantive, wired (called only from `saveRecipientSetCore`) |
| `lib/data/recipients.ts` | userId-first DAL | ✓ VERIFIED | Present, substantive, wired (barrel + actions-core), IDOR-tested |
| `lib/data/index.ts` | barrel re-export | ✓ VERIFIED | Present, exports recipients DAL |
| `lib/csv/actions-core.ts` | `parseUploadedCsvCore`/`saveRecipientSetCore`, no server directive | ✓ VERIFIED | Present, substantive, wired, 12 seam tests pass |
| `lib/csv/actions.ts` | `"use server"` auth-gated wrappers | ✓ VERIFIED | Present, substantive, wired (imported by `csv-uploader.tsx`) |
| `lib/csv/index.ts` | barrel (types + pure helpers, no server actions) | ✓ VERIFIED | Present, correctly excludes runtime action re-export |
| `next.config.ts` | `bodySizeLimit: "4mb"` | ✓ VERIFIED | Present |
| `app/(app)/recipients/page.tsx` | RSC: auth → scoped list → empty/populated states + uploader | ✓ VERIFIED | Present, substantive, real DB read (`listRecipientSetsForUser`), builds |
| `components/recipients/csv-uploader.tsx` | client upload→review→save flow | ✓ VERIFIED | Present, substantive, fully wired to real Server Actions, 474 lines of real logic |
| `components/app-sidebar.tsx` | Recipients nav slot | ✓ VERIFIED | Present |
| `components/ui/select.tsx`, `components/ui/table.tsx` | shadcn primitives | ✓ VERIFIED | Present, hand-authored to match repo conventions (documented deviation, functionally equivalent) |
| `docker-compose.yml` / `.env.example` | `UPLOADS_PATH` wiring | ✓ VERIFIED | Present, `docker compose config` valid |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `csv-uploader.tsx` | `lib/csv/actions` (`parseUploadedCsv`/`saveRecipientSet`) | direct FormData action calls | ✓ WIRED | Imports confirmed, real calls with pending-state handling |
| `csv-uploader.tsx` invalid-count line | `parseResult.data.invalidCounts[selectedColumn]` | server-computed map lookup on every Select change | ✓ WIRED | Source-confirmed, browser-UAT-proven live recompute |
| `app/(app)/recipients/page.tsx` | `@/lib/data listRecipientSetsForUser` | `auth()` → userId → scoped list | ✓ WIRED | `grep -c listRecipientSetsForUser` = 3 in page.tsx (import + JSDoc + call) |
| `actions.ts` | `@clerk/nextjs/server auth()` | lazy import + userId re-derivation | ✓ WIRED | Both exported actions gate on `auth()` |
| `actions-core.ts saveRecipientSetCore` | `writeUpload` + `createRecipientSet` | write bytes then insert row, post-validation | ✓ WIRED | Order confirmed in source and by orphan-avoidance test |
| `actions-core.ts parseUploadedCsvCore` | `countInvalidEmails` per column → `invalidCounts` | `Object.fromEntries(columns.map(...))` | ✓ WIRED | Source-confirmed, test-asserted |
| `getRecipientSetForUser`/`listRecipientSetsForUser` | `recipient_sets` table via `db` | drizzle `and(eq(id), eq(userId))` / `eq(userId)` | ✓ WIRED | IDOR structurally enforced, 6-test harness |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `app/(app)/recipients/page.tsx` | `sets` | `listRecipientSetsForUser(userId)` → real drizzle query against SQLite `recipient_sets` table | Yes | ✓ FLOWING |
| `csv-uploader.tsx` review step | `data` (`ParseSummary`) | `parseUploadedCsv(fd)` → `parseUploadedCsvCore` → real `parseCsv` over uploaded bytes | Yes | ✓ FLOWING |
| `csv-uploader.tsx` save | persisted row | `saveRecipientSet(fd)` → `saveRecipientSetCore` → `writeUpload` + `createRecipientSet` → real INSERT | Yes | ✓ FLOWING (browser-UAT-confirmed actual row on disk + in DB) |

No static/hardcoded/empty fallbacks found in the render path; no hollow props at call sites.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full lib test suite green | `npm test` | 123 pass, 0 fail | ✓ PASS |
| Typecheck clean | `npx --no-install tsc --noEmit` | exit 0, no output | ✓ PASS |
| Production build succeeds, `/recipients` route compiles | `npm run build` | "✓ Compiled successfully"; `/recipients` listed as dynamic (ƒ) route | ✓ PASS |
| `docker-compose.yml` parses | `docker compose config` | exit 0 | ✓ PASS |
| All referenced commits exist in history | `git log --oneline --all \| grep <hashes>` | all 14 referenced commit hashes found | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention or explicit probe declarations found in this phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no declared or conventional probes for this phase — verification instead relies on the full automated test suite + build, both executed directly above).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CSV-01 | 03-01, 03-03, 03-04, 03-05 | User can upload a CSV file through the browser | ✓ SATISFIED | `uploadFileSchema` guard, `parseUploadedCsv`/`saveRecipientSet` actions, `csv-uploader.tsx` upload step, browser + staging UAT. **REQUIREMENTS.md checkbox is still unchecked** — documentation staleness, not a functional gap (see Anti-Patterns). |
| CSV-02 | 03-01 | App parses the CSV robustly (quoted fields, BOM, CRLF, encoding) and detects the header row | ✓ SATISFIED | Already checked `[x]` in REQUIREMENTS.md (carried from earlier scoping); `lib/core/csv.ts` + tests confirm. Encoding scope = UTF-8 only per documented Assumption A1. |
| CSV-03 | 03-01, 03-03, 03-04 | App auto-detects the recipient (email) column and lets the user confirm or override it | ✓ SATISFIED | `detectEmailColumn`, Select UI, override-recompute proven live. **REQUIREMENTS.md checkbox unchecked** — documentation staleness. |
| CSV-04 | 03-01, 03-03, 03-04 | App validates recipient email addresses at upload and reports the count of invalid rows | ✓ SATISFIED | `countInvalidEmails`, `invalidCounts` map, UI count line, override-driven recompute test + browser proof. **REQUIREMENTS.md checkbox unchecked** — documentation staleness. |
| CSV-05 | 03-01, 03-02, 03-03, 03-04, 03-05 | Parsed recipients and detected columns are saved as a recipient set for the campaign | ✓ SATISFIED | `createRecipientSet`, `recipient_sets` schema, persisted row confirmed live (browser + staging). **REQUIREMENTS.md checkbox unchecked** — documentation staleness. |
| AUTH-02 | 03-02, 03-03, 03-04 | Multi-tenant isolation enforced on every data access | ✓ SATISFIED (already checked `[x]` in REQUIREMENTS.md) | `getRecipientSetForUser`/`listRecipientSetsForUser` structural `and(eq(id), eq(userId))`; two-tenant IDOR test harness; both Server Actions re-derive `userId` via `auth()`. |

No orphaned requirements — every ID mapped to Phase 3 in REQUIREMENTS.md's traceability table (CSV-01..05) is claimed by at least one plan's frontmatter, and every claim is evidenced in code.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `.planning/REQUIREMENTS.md` | 26, 28-32 | CSV-01/03/04/05 checkboxes still `[ ]` (unchecked) despite Phase 3 code evidence satisfying them, and the traceability table (lines 128-132) still shows "Pending" | ℹ️ INFO | Documentation-only staleness — ROADMAP.md already marks Phase 3 `[x]` complete (2026-07-13) and this verification confirms the code is genuinely done. Recommend updating REQUIREMENTS.md checkboxes as part of phase closeout so the traceability doc doesn't understate progress at milestone audit time. Does not block phase-goal achievement. |

No TBD/FIXME/XXX/TODO/HACK markers, no placeholder/stub returns, no hardcoded-empty renders, and no destructive-styling misuse were found in any of the 14 files this phase created/modified. All grep hits for "placeholder" were legitimate UI placeholder-attribute text (Select/input hints), not stub markers.

### Human Verification Required

None. Both human-verification touchpoints this phase produced were already executed and resolved before this report:
- Browser UAT (03-04): performed autonomously via agent-browser against a real Clerk test user on local dev — all 6 checks PASS, one rendering bug found and fixed live (commit `a869186`), re-verified.
- Staging deploy + restart-persistence smoke (03-05, `checkpoint:human-action` + `checkpoint:human-verify`): both gates resolved with explicit user confirmation ("deployed" and "approved") recorded in 03-05-SUMMARY.md, including the restart-survival proof for success criterion 5.

### Gaps Summary

No gaps. All 5 roadmap success criteria and all 21 plan-level must-have truths across the phase's 5 plans are verified against the actual codebase — not just SUMMARY claims. Full backing evidence: 123/123 tests pass (including 2 dedicated IDOR harnesses and an end-to-end parse→save persistence test), `tsc --noEmit` and `npm run build` both clean, `docker compose config` valid, every commit referenced in the SUMMARYs exists in git history, and the two manual-only checkpoints (browser UAT, staging deploy) were independently executed and approved rather than merely claimed.

The single non-blocking observation is that REQUIREMENTS.md's per-requirement checkboxes for CSV-01/03/04/05 were not flipped to `[x]` even though ROADMAP.md already marks the phase complete and the code fully satisfies them — a documentation-sync note for phase closeout, not a functional or code gap.

---

*Verified: 2026-07-13*
*Verifier: Claude (gsd-verifier)*
