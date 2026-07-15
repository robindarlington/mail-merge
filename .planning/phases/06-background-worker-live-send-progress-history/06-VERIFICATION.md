---
phase: 06-background-worker-live-send-progress-history
verified: 2026-07-15T00:00:00Z
status: human_needed
score: 6/7 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Staging deploy + live send on Coolify (Plan 06-07 step 1-2): sign in on staging, verified BYO SMTP, small CSV (include a duplicate + a rejectable address), start a live send from /compose, open /campaigns → campaign detail"
    expected: "Progress bar advances; sent/failed/remaining update every ~2s; 'Currently sending to {email}' tracks the active recipient"
    why_human: "Roadmap SC7 requires the slice deployed and working on the standing staging URL; live-progress feel and real SMTP behavior can't be verified by grep"
  - test: "Crash-resume no-double-send (Plan 06-07 step 3): hard-kill the worker container mid-batch in Coolify, then restart it"
    expected: "Send completes; NO recipient sent twice (zero duplicates in inbox/SMTP logs); the mid-flight recipient shows 'Interrupted' (terminal, not re-sent); campaign ends Completed"
    why_human: "The end-to-end crash/reclaim/orphan-sweep behavior against a real container lifecycle and real SMTP can only be observed live (unit tests cover the seams, not the deployment)"
  - test: "History + drill-down rendering (Plan 06-07 step 4): /campaigns list and detail page after the send"
    expected: "List shows status + '{sent}/{total} sent'; detail shows per-recipient status + reason + sent-at; rejected styled destructive, interrupted styled muted"
    why_human: "Visual styling and rendered content quality require a browser"
  - test: "Results CSV download (Plan 06-07 step 5): click 'Download results' on the completed campaign and open the file in a spreadsheet"
    expected: "campaign-{id}-results.csv downloads with correct columns; any value starting with = + - @ is prefixed with a single quote (no formula executes)"
    why_human: "Actual browser download + spreadsheet formula-neutralization behavior is not grep-verifiable"
  - test: "IDOR export check (Plan 06-07 step 6, deferred from Plan 06-06): as a second user (or by editing the campaign id in the URL), GET another user's /campaigns/{id}/export"
    expected: "404 — no data leak"
    why_human: "Requires two live authenticated Clerk sessions against the deployed app"
---

# Phase 6: Background Worker + Live Send + Progress + History — Verification Report

**Phase Goal:** A live send runs as a crash-safe background job that sends one personalized email per recipient, shows live progress, persists per-recipient outcomes, and is fully resumable — backed by the `send_record` state machine.
**Verified:** 2026-07-15
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria — the contract)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Live send survives the HTTP lifecycle and a worker restart: atomic claim, one `pending` send_record per row, one personalized email per recipient over the user's SMTP with configurable throttle | ✓ VERIFIED | `lib/worker/claim.ts` — single `UPDATE…WHERE id=(subquery)…RETURNING` atomic claim incl. stalled-lease reclaim; `lib/worker/materialize.ts` — one pending record per unique address via `onConflictDoNothing`; `lib/worker/process.ts` — `runCampaign` reuses `lib/core` `verifyTransport`/`sendOne`/`throttle`; `SEND_DELAY_MS` env (default 1000ms) threaded worker→tick→runCampaign; separate `worker` compose service + `npm run worker` |
| 2 | Per-recipient state persisted (`pending → sending → sent`/`failed`) with error reason + timestamp; per-row failures don't abort the batch; failed count surfaced | ✓ VERIFIED | `process.ts:172-252` — fenced `pending→sending` commit before the SMTP await, terminal write + counter bump in one synchronous transaction; `sendOne` never throws (structured SendResult, try/continue); `failed_count` bumped and surfaced in list/detail/progress UIs; error stored as message STRING |
| 3 | User sees live per-recipient progress (sent / failed / remaining + current recipient) during a send | ✓ VERIFIED (code) | `components/campaign/progress-panel.tsx` — polls `getCampaignProgress` every 2s, stops on terminal, renders server-derived sent/failed/remaining + "Currently sending to {addr}"; action → `getCampaignProgressCore` → `getCampaignProgressRow` (real DB read incl. the lone `sending` row). Live feel confirmed by 06-07 walkthrough |
| 4 | After crash/restart only `pending` recipients are processed — no double-send ever | ✓ VERIFIED (code) | `process.ts:142-151` selects `status='pending'` only; `recover.ts` sweeps orphaned `sending`→terminal `failed(interrupted)` (never back to pending); status-fenced row claims + worker_id-fenced heartbeat (`LeaseLostError`) and finalize block a live-but-slow stale worker (CR-01 fix 9af7bed); tests: "resume sends ONLY pending rows — an already-sent recipient is never re-sent (SEND-06)", "materialize is idempotent on resume: a second call inserts ZERO rows". Real-container kill test is the 06-07 walkthrough |
| 5 | User can view past campaigns and drill into per-recipient success/fail + error reasons | ✓ VERIFIED | `app/(app)/campaigns/page.tsx` (RSC → `listCampaignsForUser`, newest-first); `app/(app)/campaigns/[id]/page.tsx` (RSC → `getCampaignForUser` + `getSendRecordsForCampaign`, cross-tenant/NaN id → `notFound()`); `recipient-results-table.tsx`; "Campaigns" nav in `components/app-sidebar.tsx:33` |
| 6 | User can download a CSV of per-recipient results (HIST-03) | ✓ VERIFIED | `app/(app)/campaigns/[id]/export/route.ts` — auth → `getCampaignForUser` (404 on cross-tenant) → `getSendRecordsForCampaign` → `toResultsCsv`; `lib/campaign/results-csv.ts` — formula-leader `'`-prefix then RFC-4180 quoting, CRLF; detail page renders the Download button once terminal |
| 7 | Phase slice deployed to standing staging URL (Coolify) and works there | ? HUMAN | Plan 06-07 is a deliberately queued `checkpoint:human-verify` (staging redeploy + live-send + crash-resume walkthrough). Not a code gap; listed under Human Verification Required |

**Score:** 6/7 truths verified (SC7 routed to human checkpoint per phase plan)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `lib/worker/claim.ts` | atomic single-UPDATE claim (min 30 lines) | ✓ VERIFIED | 81 lines; prepared `UPDATE…RETURNING id` incl. stalled-lease branch, `worker_id` stamp, `COALESCE(started_at)` |
| `lib/worker/recover.ts` | sending→failed(interrupted) sweep + failed_count bump (min 20) | ✓ VERIFIED | 65 lines; single-statement sweep, transactional counter bump (WR-04 fix 0910b9b) |
| `lib/worker/finalize.ts` | markCompleted/markFailed + lease release (min 25) | ✓ VERIFIED | 81 lines; both fenced on `worker_id` (CR-01), lease nulled, `finished_at` stamped |
| `lib/worker/materialize.ts` | idempotent CSV→fill→insert + total reconcile (min 35) | ✓ VERIFIED | 139 lines; `onConflictDoNothing`, blank-cell skip + invalid-address terminal materialization (WR-05 fix 111efec), dedup-honest total |
| `lib/worker/process.ts` | verify-once send loop with per-row commit (min 45) | ✓ VERIFIED | 267 lines; fenced transitions, transactional counters, transient password, transport timeouts capped below lease |
| `lib/worker/loop.ts` | tick() composition with injectable deps (min 40) | ✓ VERIFIED | 183 lines; claim→recover→materialize→run→finalize, poison-pill catch → `markFailed` (CR-02 fix f5ba15e), `LeaseLostError` abort |
| `worker/index.ts` | pino + poll interval + SIGTERM composition root (min 40) | ✓ VERIFIED | 135 lines; fail-closed `envInt` (WR-06 fix 3ee653f), overlap guard, SIGTERM/SIGINT cooperative drain (WR-03 fix 2e6c665) |
| `lib/data/campaigns.ts` | userId-scoped list/records/progress reads (min 40) | ✓ VERIFIED | 162 lines; every read owner-gated via `getCampaignForUser` first |
| `lib/campaign/actions-core.ts` | `getCampaignProgressCore` export | ✓ VERIFIED | Exported at line 552; zod-parses id, derives `remaining`, IDOR → not_found |
| `lib/campaign/actions.ts` | `getCampaignProgress` server action | ✓ VERIFIED | auth() → delegate with server-derived userId (line 125-131) |
| `app/(app)/campaigns/page.tsx` | history list RSC (min 40) | ✓ VERIFIED | 143 lines; `listCampaignsForUser` newest-first |
| `app/(app)/campaigns/[id]/page.tsx` | detail RSC with progress + results (min 45) | ✓ VERIFIED | 170 lines; active → ProgressPanel with initial server counts; failed → sent-count-aware Alert (WR-02 fix c22d92c) |
| `components/campaign/progress-panel.tsx` | client polling panel (min 45) | ✓ VERIFIED | 164 lines; 2s poll, terminal stop, rejected-promise retry path (WR-01 fix 3e8e10f) |
| `components/campaign/recipient-results-table.tsx` | per-recipient results table | ✓ VERIFIED | 143 lines, rendered on detail page |
| `lib/campaign/results-csv.ts` | RFC-4180 + formula-injection-safe serializer (min 30) | ✓ VERIFIED | 99 lines; guard-then-quote order, interrupted label, ISO sent_at |
| `app/(app)/campaigns/[id]/export/route.ts` | userId-scoped GET export (min 25) | ✓ VERIFIED | 47 lines; 401/404 paths, Content-Disposition attachment |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| claim.ts | @/lib/db connection | `connection.prepare` raw UPDATE…RETURNING | ✓ WIRED | claim.ts:56-58 |
| recover.ts | send_records | UPDATE status='failed' WHERE status='sending' | ✓ WIRED | recover.ts:43-53 |
| process.ts | lib/core sendOne/verifyTransport/throttle | reused primitives, no new send code | ✓ WIRED | process.ts:43-49, 136, 188, 258 |
| materialize.ts | UNIQUE(campaign_id,to_addr) | `onConflictDoNothing` | ✓ WIRED | materialize.ts:105 |
| loop.ts | claim/recover/materialize/process/finalize | composed tick | ✓ WIRED | loop.ts:33-37, 82-159 |
| worker/index.ts | loop tick | setInterval + SIGTERM stop flag | ✓ WIRED | worker/index.ts:74-132 |
| data/campaigns.ts getSendRecordsForCampaign | campaign ownership | `getCampaignForUser` guard first | ✓ WIRED | campaigns.ts:129-130 |
| actions.ts getCampaignProgress | getCampaignProgressCore | auth() then delegate | ✓ WIRED | actions.ts:125-131 |
| progress-panel.tsx | getCampaignProgress action | 2s setInterval, stop on terminal | ✓ WIRED | progress-panel.tsx:48-81 |
| campaigns/[id]/page.tsx | getCampaignForUser + getSendRecordsForCampaign | userId-scoped RSC reads | ✓ WIRED | page.tsx:60-70 |
| export/route.ts | auth + owner-gated DAL + toResultsCsv | IDOR-scoped read before streaming | ✓ WIRED | route.ts:28-39 |
| confirm-send-dialog.tsx | enqueueCampaign action | draft→queued (feeds the worker's claim) | ✓ WIRED | confirm-send-dialog.tsx:114 |
| docker-compose.yml | worker service | same image, `npx tsx worker/index.ts` | ✓ WIRED | docker-compose.yml:59-65 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| progress-panel.tsx | `progress` state | getCampaignProgress → getCampaignProgressRow (campaigns counters + live `sending` row) | Yes — real drizzle queries | ✓ FLOWING |
| campaigns/page.tsx | campaign list | listCampaignsForUser (db.query.campaigns.findMany) | Yes | ✓ FLOWING |
| campaigns/[id]/page.tsx | `records`, initialProgress | getSendRecordsForCampaign + campaign counters (server-computed, not hardcoded) | Yes | ✓ FLOWING |
| export/route.ts | CSV body | owner-gated send_records → toResultsCsv | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Type-safety | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Full test suite (worker seams, resume/no-double-send, CSV escaping, IDOR cores) | `npm test` | 265 pass / 0 fail | ✓ PASS |
| Key no-double-send tests present | grep test names | "resume sends ONLY pending rows… (SEND-06)", "materialize is idempotent on resume", "shouldStop drains between rows (WR-03)", sweep/counter tests | ✓ PASS |
| Live send against real SMTP / running server | — | Not runnable here (needs deployed worker + SMTP) | ? SKIP → human |

### Probe Execution

No probes declared in any 06-* PLAN/SUMMARY and no `scripts/*/tests/probe-*.sh` exist. Step 7c: SKIPPED (no probe contract for this phase).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SEND-01 | 06-01, 06-04 | Background job survives HTTP lifecycle + worker restarts | ✓ SATISFIED (code) | claim/lease/reclaim + standalone worker process |
| SEND-02 | 06-02 | One personalized email per recipient, configurable throttle | ✓ SATISFIED | fillMessage-merged records; SEND_DELAY_MS → throttle between sends |
| SEND-03 | 06-02 | Per-recipient state machine with error + timestamp | ✓ SATISFIED | fenced pending→sending→sent/failed writes, `sent_at`, `error` |
| SEND-04 | 06-02 | Failures don't abort batch; failed count surfaced | ✓ SATISFIED | structured SendResult try/continue; failed_count in UI + CSV |
| SEND-05 | 06-03, 06-05 | Live progress (sent/failed/remaining + current) | ✓ SATISFIED (code) | progress action + polling panel |
| SEND-06 | 06-01, 06-02, 06-04 | Idempotent + resumable; no double-send | ✓ SATISFIED (code) | pending-only loop, terminal orphan sweep, worker_id fences; staging kill-test is 06-07 |
| HIST-01 | 06-03, 06-05 | Campaign history list | ✓ SATISFIED | /campaigns RSC |
| HIST-02 | 06-03, 06-05 | Drill-down per-recipient status + reasons | ✓ SATISFIED | /campaigns/[id] RSC + results table |
| HIST-03 | 06-06 | Downloadable results CSV | ✓ SATISFIED | export route + toResultsCsv |

No orphaned requirements: REQUIREMENTS.md maps exactly SEND-01..06 + HIST-01..03 to Phase 6, all claimed across plans 06-01..06-06.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX/TODO, no placeholder stubs, no empty handlers in any phase-06 file | — | Clean |

Review closure: all 2 Critical (CR-01 lease-steal fencing, CR-02 poison-pill queue loop) and all 6 Warnings (WR-01..WR-06) in 06-REVIEW.md carry `Fixed:` annotations pointing at real commits (9af7bed, f5ba15e, 3e8e10f, c22d92c, 2e6c665, 0910b9b, 111efec, 3ee653f — all verified to exist), and the corresponding code is present as described. IN-01..IN-08 are informational and unfixed by design.

### Human Verification Required

All items are consolidated in Plan 06-07's blocking `checkpoint:human-verify` (Coolify staging walkthrough) — deliberately queued per the operator's standing autonomy preference; Phase 6 must not be marked shipped until it passes.

#### 1. Staging deploy + live send with live progress (SC7 + SC3 feel)

**Test:** Deploy the slice to the standing Coolify staging URL with the worker service running; start a live send from /compose with a small CSV (include one duplicate + one rejectable address); open the campaign detail.
**Expected:** Progress bar advances; sent/failed/remaining update every ~2s; "Currently sending to {email}" tracks the active recipient.
**Why human:** Deployment state and real-time UI behavior against real SMTP cannot be verified from the codebase.

#### 2. Crash-resume, no double-send (SC4 end-to-end)

**Test:** Hard-kill the worker container mid-batch in Coolify, then restart it.
**Expected:** Send completes; zero duplicate deliveries in the test inbox / SMTP logs; the mid-flight recipient shows "Interrupted" (terminal); campaign ends "Completed".
**Why human:** The container-lifecycle crash path against a live SMTP can only be observed on the deployment; unit tests cover the seams in isolation.

#### 3. History + drill-down rendering (SC5 visual)

**Test:** Review /campaigns list and the campaign detail after the send.
**Expected:** Correct status + "{sent}/{total} sent"; per-recipient status/reason/sent-at; rejected styled destructive, interrupted muted.
**Why human:** Visual styling quality requires a browser.

#### 4. Results CSV download in a real spreadsheet (SC6)

**Test:** Click "Download results" on the completed campaign; open the CSV in Excel/Sheets.
**Expected:** `campaign-{id}-results.csv` with correct columns; leading `= + - @` values are `'`-prefixed and render as text, never a formula.
**Why human:** Browser download + spreadsheet interpretation is not grep-verifiable.

#### 5. IDOR export check as second user (deferred from Plan 06-06)

**Test:** As user B (or by editing the id in the URL), GET user A's /campaigns/{id}/export.
**Expected:** 404, no data leak.
**Why human:** Requires two live authenticated Clerk sessions.

### Gaps Summary

No code gaps. All six code-level success criteria are implemented, wired end-to-end (enqueue → atomic claim → orphan sweep → idempotent materialize → fenced send loop → finalize → history/progress/export reads), covered by 265 passing tests, and hardened per the 06-REVIEW fixes (worker_id fencing, poison-pill terminal failure, cooperative SIGTERM drain, transactional counters, invalid-email materialization, fail-closed env parsing). The single outstanding item is the seventh success criterion — the Coolify staging deploy + live walkthrough — which is Plan 06-07, a deliberately queued blocking human checkpoint. Status is therefore `human_needed`, not `passed`.

---

_Verified: 2026-07-15_
_Verifier: Claude (gsd-verifier)_
