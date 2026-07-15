---
phase: 06-background-worker-live-send-progress-history
plan: 05
subsystem: web-ui
tags: [next-rsc, react-client, polling, shadcn, idor, multi-tenant, status-vocabulary]

# Dependency graph
requires:
  - phase: 06 plan 03
    provides: listCampaignsForUser, getSendRecordsForCampaign, getCampaignProgress action, ProgressData type
  - phase: 05
    provides: getCampaignForUser IDOR idiom, app shell + sidebar, test-send-panel client-poll idiom
provides:
  - "Campaigns nav slot (lucide Send) — list + drill-down entry"
  - "/campaigns history list RSC (HIST-01, newest first, userId-scoped)"
  - "/campaigns/[id] detail RSC (HIST-02) — progress panel + results table + gated download"
  - "ProgressPanel client poller (SEND-05, ~2s, stops on terminal, self-heals)"
  - "RecipientResultsTable — failed-vs-interrupted per-recipient rows"
  - "CampaignStatusBadge + CampaignSummaryLine — single-sourced status/terminal vocabulary"
  - "components/ui/progress.tsx — official shadcn Progress primitive"
affects: [06-06 csv-export-route]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Client poll over a userId-scoped server action (setInterval in useEffect, cleanup clears it, status in deps stops polling on terminal)"
    - "Server-authoritative counts: remaining rendered from data.remaining, never client-recomputed"
    - "Stretched-link table rows (after:absolute after:inset-0) for whole-row navigation without per-row accent"
    - "Redacted SMTP DTO (toSmtpConfigDto) for any client-facing sender display"

key-files:
  created:
    - app/(app)/campaigns/page.tsx
    - app/(app)/campaigns/[id]/page.tsx
    - components/campaign/progress-panel.tsx
    - components/campaign/recipient-results-table.tsx
    - components/campaign/campaign-status-badge.tsx
    - components/campaign/campaign-summary-line.tsx
    - components/ui/progress.tsx
  modified:
    - components/app-sidebar.tsx

key-decisions:
  - "Extracted CampaignStatusBadge + CampaignSummaryLine as shared components so the fixed Status Vocabulary and completed-state copy are single-sourced across the list, detail RSC, and live panel"
  - "List-page row title resolves the template subject via a single listTemplatesForUser lookup map (avoids per-row N+1)"
  - "Whole-campaign failed Alert renders a generic abort reason — the campaigns schema has no reason/error column to fill the UI-SPEC {reason} slot"

requirements-completed: [SEND-05, HIST-01, HIST-02]

# Metrics
duration: ~20min
completed: 2026-07-15
---

# Phase 6 Plan 05: Campaign History + Live Progress UI Summary

**The read-and-monitor UI slice — a Campaigns nav slot, a userId-scoped history list, a per-recipient drill-down with failed-vs-interrupted styling, and a ~2s-polling live progress panel — every surface an IDOR-safe view over the persisted `send_records` state machine, matching the approved 06-UI-SPEC.**

## Performance
- **Duration:** ~20 min
- **Tasks:** 3 (all `type=auto`)
- **Files:** 7 created, 1 modified
- **Build:** `npm run build` succeeds; both `/campaigns` and `/campaigns/[id]` routes compile
- **Type-check:** `npx tsc --noEmit` clean

## Accomplishments
- **Nav + list (Task 1):** added the "Campaigns" nav item (lucide `Send`) between Compose and SMTP Settings; installed the official shadcn `Progress` primitive (zero new npm deps — its Radix dep ships in the already-present unified `radix-ui`); built `/campaigns` as an async RSC listing the user's campaigns newest-first with status Badge + `{sent}/{total} sent` (+ muted `{failed} failed`), an empty state with the single "Go to compose" accent CTA, and neutral stretched-link rows.
- **Detail + results (Task 2):** built `/campaigns/[id]` (Next 16 async params) reading only through userId-scoped DAL functions, `notFound()` on unknown/cross-tenant/non-numeric id; meta line sender from the redacted SMTP DTO; hosts the live panel while queued/running, a static summary or destructive abort Alert once terminal; `RecipientResultsTable` distinguishing `failed`(rejected, XCircle/destructive) from `failed`(interrupted, AlertTriangle/muted), rendering `to_addr`/reason as escaped JSX text.
- **Live progress (Task 3):** `ProgressPanel` client poller calling `getCampaignProgress` every ~2s, stopping on `completed`/`failed`, self-healing on a poll hiccup (keeps last counts + muted "Couldn't refresh progress — retrying."), rendering a determinate `Progress` bar and Display-28px sent/failed/remaining counts (remaining straight from `data.remaining`), the current recipient line, and the shared terminal summary when it reaches a terminal state mid-poll.

## Task Commits
1. **Task 1** feat(06-05): Campaigns nav slot + history list page — `ae6b616`
2. **Task 3** feat(06-05): live progress panel with ~2s polling — `91195f8`
3. **Task 2** feat(06-05): campaign detail page + per-recipient results table — `c114ea6`

(Task 3's panel was built and committed before Task 2's detail page so every commit compiles — the detail page imports `ProgressPanel`.)

## Files Created/Modified
- `components/app-sidebar.tsx` — added the "Campaigns"/`Send` nav item; removed the now-satisfied "Future nav slots" comment; updated the doc header.
- `app/(app)/campaigns/page.tsx` — history list RSC (HIST-01): `listCampaignsForUser` + `listTemplatesForUser` map for titles, empty state, populated `Table`, `formatRelativeDate`.
- `app/(app)/campaigns/[id]/page.tsx` — detail RSC (HIST-02): ownership-gated reads, `notFound()`, redacted sender meta, progress/summary/abort switch, state-gated Download button.
- `components/campaign/progress-panel.tsx` — SEND-05 client poller.
- `components/campaign/recipient-results-table.tsx` — per-recipient results (server component).
- `components/campaign/campaign-status-badge.tsx` — shared fixed campaign-status vocabulary.
- `components/campaign/campaign-summary-line.tsx` — shared completed-state terminal copy.
- `components/ui/progress.tsx` — official shadcn Progress primitive.

## Decisions Made
- **Shared vocabulary components.** `CampaignStatusBadge` and `CampaignSummaryLine` were extracted so the fixed Status Vocabulary and the three completed-state summary strings are defined once and reused by the list, the detail RSC, and the live panel — the panel reaches terminal by polling (needs the summary) while a fresh load of an already-terminal campaign renders the same summary from the RSC. This keeps the 06-UI-SPEC contract un-drifted.
- **Single template lookup for row titles.** Rather than a `getTemplateForUser` per list row (N+1), the list loads `listTemplatesForUser` once and maps subject by `template_id`.
- **Stretched-link rows.** Whole-row navigation without a per-row accent uses `after:absolute after:inset-0` on the title `Link` inside a `relative` `TableRow` — satisfies the one-accent discipline (rows are neutral; the only accents are the active-nav indicator and the empty-state CTA).

## Deviations from Plan

### Auto-fixed / structural additions

**1. [Rule 3 - Organization] Two shared vocabulary components added beyond the plan's `files_modified` list**
- **Found during:** Tasks 1–3.
- **Reason:** The plan lists per-file targets but the fixed Status Vocabulary (campaign badge) and the completed-state terminal copy are each needed in 2–3 places (list + detail + panel). Duplicating the strings/icon mapping would risk the exact contract drift the UI-SPEC warns against.
- **Fix:** Created `components/campaign/campaign-status-badge.tsx` and `components/campaign/campaign-summary-line.tsx` as the single source of truth; all surfaces import them.
- **Commits:** `ae6b616` (badge), `91195f8` (summary line).

**2. [Note] Whole-campaign `failed` Alert uses a generic abort reason**
- **Found during:** Task 2.
- **Issue:** The 06-UI-SPEC abort copy has a `{reason}` slot, but the `campaigns` table has no reason/error column to source it from.
- **Fix:** Rendered the abort Alert with a generic-but-accurate reason ("Your SMTP server didn't accept the connection, or the settings were no longer valid…") preserving intent + next step. No schema change (would be Rule 4 / out of scope).

**3. [Note] `formatRelativeDate` copied from `/lists/page.tsx`, not `/recipients/page.tsx`**
- **Reason:** `app/(app)/recipients/page.tsx` is now a redirect stub — the list RSC (with the helper the plan referenced) moved to `app/(app)/lists/page.tsx`. Copied the identical helper from its current home.

## Threat Model Compliance
- **T-06-14 (IDOR on list + detail):** every read derives `userId` via `auth()` and uses userId-scoped DAL functions; unknown/cross-tenant/non-numeric id → `notFound()`. No fetch-by-id-alone path.
- **T-06-15 (stored XSS):** `to_addr` and error reasons render as escaped JSX text; no `dangerouslySetInnerHTML` anywhere (grep-clean).
- **T-06-16 (SMTP password leak):** the detail meta line uses `toSmtpConfigDto` (redacted), which structurally omits the password triple; the raw config row never reaches the client.
- **T-06-SC (registry/npm):** only `npx shadcn add progress` (official registry component file); zero new npm dependencies.

## Verification
- `npm run build` → success; routes `/campaigns` (ƒ) and `/campaigns/[id]` (ƒ) present.
- `npx tsc --noEmit` → clean.
- Grep gates: `notFound` + `getCampaignForUser` present in detail; interrupted branch + `AlertTriangle` + `XCircle` + `text-destructive` present in results table; `getCampaignProgress` + `TERMINAL.has` guard + "Couldn't refresh progress" present in panel; "No campaigns yet" + "Go to compose" present in list; no `dangerouslySetInnerHTML` in any new file.

## Next Phase Readiness
- The Download button links to `/campaigns/[id]/export` — Plan 06 provides that GET route handler. No blockers.

---
*Phase: 06-background-worker-live-send-progress-history*
*Completed: 2026-07-15*

## Self-Check: PASSED
All seven created files exist on disk (plus the modified sidebar); all three task commits (ae6b616, 91195f8, c114ea6) are present in git history.
