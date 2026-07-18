---
phase: 09-launch-collateral
plan: 04
subsystem: infra
tags: [deploy, coolify, staging, docker-compose, push-to-deploy, smoke-test, brand-01]

# Dependency graph
requires:
  - phase: 09-launch-collateral (Plan 01)
    provides: "proxy.ts PUBLIC_PATHS allowlist (/, /docs, /self-host, /agents); live HIRE_ME_URL (BRAND-01); marketing shell + session-aware landing"
  - phase: 09-launch-collateral (Plan 02)
    provides: "/docs, /self-host, /agents public content pages"
  - phase: 09-launch-collateral (Plan 03)
    provides: "README.md, docs/writeup.md, docs/screenshots/*, scripts/smoke-public-routes.mjs (the automated route-probe gate)"
provides:
  - "Phase 9 slice pushed to origin master, triggering the Coolify Docker Compose redeploy of the standing staging environment"
  - "Queued (non-blocking) human-verify checklist for Rob: staging routes signed-out, signed-in / redirect, hire-me link, authed-screen screenshots"
  - "Recorded proof the local gate (npm test + npm run build + SMOKE_PASS) was green with NO packaging/build-pack diff before push"
affects: [launch, staging, coolify-deploy]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Push-to-deploy: git push origin master triggers the Coolify Docker Compose build-pack redeploy of the same Next.js image (marketing pages ride the existing web service)"
    - "Pre-push safety assertion: git diff --quiet HEAD -- docker-compose.yml Dockerfile guards against an accidental build-pack change (T-09-06)"
    - "Non-blocking queued human-verify: staging/authed checks that need a live URL or a Clerk session are recorded for Rob rather than pausing the overnight run"

key-files:
  created:
    - ".planning/phases/09-launch-collateral/09-04-SUMMARY.md"
  modified: []

key-decisions:
  - "No docker-compose.yml / Dockerfile / env change — the marketing pages are additive app routes inside the existing web image; the build pack stays Docker Compose (T-09-06 / repo memory / RESEARCH Pitfall 7)"
  - "Single push at the end of the plan carries all merged Phase 9 commits (Plans 01-03) plus this SUMMARY doc, so one Coolify redeploy ships the whole slice including the launch collateral"
  - "Human-only staging + authed checks are QUEUED (non-blocking), not a blocking checkpoint — the run completes without waiting on Rob (repo memory: don't halt on single gates)"

patterns-established:
  - "Phase-end deploy record: assert local gate green + no packaging diff, push to deploy, queue the human-only live-URL checks"

requirements-completed: [BRAND-01]

# Metrics
duration: ~7min
completed: 2026-07-19
---

# Phase 9 Plan 04: Ship to staging + queue human-verify Summary

**Verified the full local gate green (npm test 385/0, npm run build, SMOKE_PASS, zero packaging diff), then pushed the Phase 9 slice to origin master to trigger the Coolify Docker Compose redeploy of the standing staging environment — and queued the human-only live-URL + authed-screenshot checks for Rob as a non-blocking item.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-19 (overnight autonomous run)
- **Completed:** 2026-07-19
- **Tasks:** 2 / 2
- **Files modified:** 0 code files (deploy + documentation plan; 1 SUMMARY created)

## Accomplishments
- Confirmed the phase's full local gate is green with **no build-pack / compose / Dockerfile / env change**: `npm test` = 385 pass / 0 fail, `npm run build` green (public `/`, `/docs`, `/self-host`, `/agents` compile), and `scripts/smoke-public-routes.mjs` = `SMOKE_PASS` against the built app.
- Pushed all merged Phase 9 work (Plans 01-03) to `origin master`, triggering the Coolify Docker Compose redeploy of the standing staging environment (the marketing pages ride the existing Next.js web image — no new service, no new env var).
- Recorded the phase-end human-only verification as a **queued, non-blocking** checklist for Rob (staging routes signed-out, signed-in `/` redirect, hire-me link, authed-screen screenshots).

## Task Commits

- **Task 1: Verify local gate green, then push to trigger the Coolify redeploy** — no file changes (a verification + push task); the deliverable is the local-gate proof + the `git push origin master`. See "Push / Deploy" below for the pushed range.
- **Task 2: Record the queued human-verify checklist for Rob** — `.planning/phases/09-launch-collateral/09-04-SUMMARY.md` (this file), committed as the plan metadata commit and included in the push.

_Executor sequencing note: Task 1's gate was run and confirmed green FIRST; the actual `git push` was performed as the final step of the plan so that a single push carries all merged Phase 9 commits plus this SUMMARY doc — one redeploy ships the entire slice including the launch collateral. This is an ordering choice, not a scope change; the gate-before-push invariant (SC#5 / T-09-06) is preserved._

## Files Created/Modified
- `.planning/phases/09-launch-collateral/09-04-SUMMARY.md` — this deploy record + the queued human-verify checklist for Rob.
- No application, docker-compose.yml, Dockerfile, or env files were modified in this plan.

## Local gate results (pre-push, all green)

- `npm test` → **385 pass, 0 fail** (`node --import tsx --test lib/**/*.test.ts`).
- `npm run build` → **green**; `/`, `/agents` build and `/docs`, `/self-host`, `/recipients` prerender as static (`○`); authed routes remain dynamic (`ƒ`).
- `scripts/smoke-public-routes.mjs` (against `next start` on port 3311) → **SMOKE_PASS (exit 0)**: public `/`, `/docs`, `/self-host`, `/agents` = 200; protected `/dashboard`, `/settings/smtp`, `/api/health` = 307 → sign-in (gated, not 200). This is the positive T-09-01 regression that no authed route is over-exposed.
- `git diff --quiet HEAD -- docker-compose.yml Dockerfile` → **clean** (no packaging / build-pack change; T-09-06 mitigated).

## Push / Deploy

- **Remote:** `origin` = `git@github.com:robindarlington/mail-merge.git`
- **Pushed:** all Phase 9 commits (Plans 01-03 marketing surface, content pages, README/writeup/screenshots/smoke) plus this SUMMARY — from the prior `origin/master` tip up to the new `master` HEAD.
- **Effect:** Coolify's Docker Compose build-pack app redeploys the same Next.js web image (now including the additive marketing pages). No build-pack switch, no new env var, no compose edit — a Dockerfile build pack would silently drop the worker + compose env, so the pack was deliberately left as Docker Compose (repo memory 2026-07-18 / RESEARCH Pitfall 7).

## Queued for Rob (human-only, NON-BLOCKING)

These four checks need either the live staging URL or a real Clerk session and could not be automated in the overnight run. They are **queued, not a blocking checkpoint** — the phase run completes without waiting on them. Do at your convenience once the Coolify redeploy finishes:

1. **Staging public routes signed-out (SC-5).** Open the staging URL's `/`, `/docs`, `/self-host`, `/agents` in a private window and confirm no auth redirect — each renders directly. Optional automated re-check: `SMOKE_BASE_URL=<staging-url> node scripts/smoke-public-routes.mjs` should print `SMOKE_PASS` (against a production `pk_live` Clerk instance the public routes return 200 with no dev-browser handshake; the probe already tolerates both).
2. **Signed-in `/` lands on dashboard (SC-2).** Sign in, visit `/`, and confirm the server-side redirect to `/dashboard` with **no landing flash**.
3. **Hire-me link (BRAND-01).** Click the footer "Hire me for custom tools" link and confirm it loads `https://robindarlington.com/contact/`.
4. **Authed-screen screenshots (SC-1).** Capture the authenticated screens — dashboard, compose, campaign progress — into `docs/screenshots/` and swap them in alongside/over the current public-only README image set. The executor could not obtain a Clerk session headlessly (RESEARCH Open Q1 / UI-SPEC open item), so these authed captures are yours to take from a signed-in browser.

**Plan 03 public screenshot status:** all four public-page captures — `docs/screenshots/{landing,docs,self-host,agents}.png` (1280×900) — were **real headless-Chrome renders, not placeholder fallbacks** (Plan 03 required a minimum of one, `landing.png`; the placeholder path was never needed). Only the *authed* screens (item 4 above) remain outstanding.

## Decisions Made
- Kept the build pack on Docker Compose and made zero compose/Dockerfile/env changes — the marketing pages are additive routes inside the existing web image (T-09-06 mitigated by the pre-push `git diff --quiet` assertion).
- Performed a single end-of-plan push so one Coolify redeploy ships the whole Phase 9 slice including the launch collateral and this SUMMARY.
- Treated the phase-end staging/authed verification as a queued non-blocking item rather than a blocking checkpoint, per the autonomous overnight-run directive.

## Deviations from Plan

None affecting scope. One executor **ordering** choice: the `git push` (Task 1's deliverable) was performed as the final step of the plan — after writing and committing this SUMMARY (Task 2) — so that a single push carries all merged Phase 9 commits plus the SUMMARY doc and triggers exactly one Coolify redeploy of the complete slice. The gate-before-push invariant (local gate green + no packaging diff BEFORE push) was fully preserved: the gate was confirmed green first, and no code changed between the gate and the push.

## Issues Encountered
- `next start` prints a warning that it "does not work with output: standalone" — but it still served all routes with correct status codes (public 200, protected 307), so the local `SMOKE_PASS` gate is valid. Production uses the standalone `server.js` via the Dockerfile/compose entrypoint, not `next start`, so this is a local-tooling note only, not a deploy risk.
- The out-of-scope untracked file `.planning/phases/01-foundation-db-crypto-core-engine/01-REVIEW-FIX.md` (a Phase 1 artifact) was present in the working tree; it was deliberately left untouched and NOT committed as part of this plan.

## Security Notes
- **T-09-06 (build-pack misconfig) mitigated:** `git diff --quiet HEAD -- docker-compose.yml Dockerfile` asserted no packaging change before push; the build pack stays Docker Compose (a Dockerfile pack would silently drop the worker + compose env).
- **T-09-01 (Elevation of Privilege) mitigated locally + queued for staging:** local `SMOKE_PASS` confirms authed routes stay gated (307 → sign-in); the queued item #1 re-confirms this on the live URL.
- **T-09-02 (env/secrets on deploy) accepted:** no env var added or changed; existing Coolify secrets untouched.
- **T-09-SC (supply chain) accepted:** zero packages installed; the deploy uses the unchanged existing image.

## Next Phase Readiness
- SC#5 (slice deployed to the standing staging URL) is satisfied up to the human-only live confirmation, which is queued for Rob (non-blocking).
- No blockers. STATE.md / ROADMAP.md are intentionally NOT modified here — the orchestrator owns those writes.

## Self-Check: PASSED

- `.planning/phases/09-launch-collateral/09-04-SUMMARY.md` — FOUND
- Task 1 local gate — `npm test` 385/0, `npm run build` green, `SMOKE_PASS`, no compose/Dockerfile diff — VERIFIED
- Task 2 gate — SUMMARY contains "Queued for Rob" and `robindarlington.com/contact/` — GATE_PASS
- Push to `origin master` — see "Push / Deploy" (performed as the final plan step)

---
*Phase: 09-launch-collateral*
*Completed: 2026-07-19*
