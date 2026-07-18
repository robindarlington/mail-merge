---
phase: 09-launch-collateral
plan: 03
subsystem: launch-collateral
tags: [readme, writeup, screenshots, smoke-test, route-probe, brand-01]

requires:
  - phase: 09-launch-collateral (Plan 01)
    provides: "proxy.ts PUBLIC_PATHS allowlist (/, /docs, /self-host, /agents); live HIRE_ME_URL (BRAND-01)"
  - phase: 09-launch-collateral (Plan 02)
    provides: "/docs, /self-host, /agents content pages the README points at"
provides:
  - "Repo-root README.md: what/screenshot/niches/features/quickstart/self-host+CLI/MCP pointers/MIT/attribution"
  - "docs/writeup.md: how-it-was-built narrative draft for robindarlington.com/thoughts/"
  - "docs/screenshots/{landing,docs,self-host,agents}.png (1280x900 public captures)"
  - "scripts/smoke-public-routes.mjs: dependency-free route probe — the phase's automated end-to-end gate"
affects: [launch, github-repo-first-impression]

tech-stack:
  added: []
  patterns:
    - "Dependency-free Node ESM smoke script: global fetch, redirect:manual, no third-party imports (threat T-09-SC)"
    - "Probe distinguishes the Clerk dev-instance browser handshake (cookie bootstrap, tolerated on public routes) from the real sign-in auth gate (required on protected routes)"
    - "README references screenshot by RELATIVE path so it renders on GitHub (not /public)"
    - "README points at packages/cli/README.md + in-app pages instead of duplicating snippets (anti-drift, T-09-05)"

key-files:
  created:
    - "scripts/smoke-public-routes.mjs"
    - "docs/screenshots/landing.png"
    - "docs/screenshots/docs.png"
    - "docs/screenshots/self-host.png"
    - "docs/screenshots/agents.png"
    - "README.md"
    - "docs/writeup.md"
  modified: []

key-decisions:
  - "Smoke probe omits the browser `accept: text/html` header so it has production-like route-probe semantics rather than triggering the Clerk dev-instance handshake on every route"
  - "Public-route assertion tolerates a Clerk dev handshake redirect (accounts.dev) but fails on a sign-in redirect; protected-route assertion requires a sign-in redirect or 4xx and fails on a 200 render (T-09-01)"
  - "README hire-me link points at the real https://robindarlington.com/contact/, not the CLI README's GitHub placeholder"

requirements-completed: [BRAND-01]

duration: 12 min
completed: 2026-07-18
---

# Phase 9 Plan 03: Repo-facing launch collateral Summary

Produced the public-facing repo collateral now that all four marketing routes exist: a repo-root `README.md` (with a rendered landing screenshot, the two niches, quickstart, self-host + CLI/MCP pointers, MIT, and the live Robin Darlington hire-me link), a substantial "how it was built" write-up draft at `docs/writeup.md`, four 1280x900 public-page screenshots, and a dependency-free route-probe smoke script that is the phase's automated end-to-end gate — asserting the public routes are reachable signed-out while the authed routes still redirect to sign-in.

## Performance

- **Duration:** ~12 min (start 2026-07-18T22:48Z, end 2026-07-18T23:00Z)
- **Tasks:** 2 / 2
- **Files:** 7 created, 0 modified

## What was built

### Task 1 — Route-probe smoke + public-page screenshots — commit cc1966b
- `scripts/smoke-public-routes.mjs`: a plain Node ESM script with **no imports beyond Node built-ins** (uses global `fetch`). Reads `SMOKE_BASE_URL` (default `http://localhost:3000`), probes with `redirect: "manual"`, and asserts `/`, `/docs`, `/self-host`, `/agents` return HTTP 200 while `/dashboard`, `/settings/smtp`, `/api/health` redirect to sign-in or return 4xx (never a 200 render). Prints a line per route, `SMOKE_PASS` + exit 0 on success, `SMOKE_FAIL` + exit 1 on any failed assertion.
- The script encodes the T-09-01 privilege boundary precisely: it tolerates a Clerk **development-instance browser handshake** (a one-time redirect to `accounts.dev` that bootstraps a per-browser cookie — not an auth denial) on public routes, but fails a public route that is redirected to the **sign-in** gate, and requires protected routes to be redirected to sign-in (or 4xx).
- Verified live against `next start` on port 3311: all four public routes 200, all three protected routes 307 → `/sign-in` → `SMOKE_PASS` (exit 0).
- `docs/screenshots/{landing,docs,self-host,agents}.png`: four public pages captured signed-out at `--window-size=1280,900` via system headless Chrome. All four are valid 1280x900 PNGs (landing 77KB, docs 119KB, self-host 99KB, agents 96KB). `landing.png` — the README's mandatory minimum — was captured first and is a real render, not a placeholder.

### Task 2 — Repo-root README.md + docs/writeup.md — commit 1a9225f
- `README.md` at the repo root: title + repo link `https://github.com/robindarlington/mail-merge`; one-line what-it-is; the landing screenshot referenced by **relative** path `docs/screenshots/landing.png` (renders on GitHub); a "who it's for" section naming both niches (credential delivery · per-row documents like payslips/certificates/invoices); a feature list accurate to the shipped app; a Quickstart (Node >= 24, `npm install`, copy `.env.example` → `.env`, `npm run dev`); a Self-host section pointing at the in-app `/self-host` page + `docs/`; a CLI & MCP section pointing at `packages/cli/README.md` and `/agents`; a `MIT` License section; and an Author section reading "Built by Robin Darlington" with the live hire-me link `https://robindarlington.com/contact/` (BRAND-01). Sentence case, no fabricated metrics.
- `docs/writeup.md`: a 77-non-blank-line "how it was built" narrative draft — the story of generalizing the one-off `send-credentials.ts` CLI into a self-serve multi-tenant web product; the architecture choices (Next.js full-stack + Clerk auth; one WAL-mode SQLite file shared by the web app and a long-lived Node worker on Coolify/VPS; BYO-SMTP with AES-256-GCM credentials at rest); the per-recipient `send_record` state machine as the idempotency/progress/resume linchpin (honestly described as at-least-once); and the spec-driven, AI-assisted build process. No fabricated numbers or testimonials.

## Deviations from Plan

None - plan executed exactly as written. All four public screenshots were captured (the plan required a minimum of one, `landing.png`, with a placeholder fallback that was not needed). Both task gates and all acceptance criteria pass.

## Authentication Gates

None encountered. No `npm install`, deploy, or login step was required. The build/server used the project `.env` (Clerk **development** keys) purely to boot the app for screenshots and the live smoke run; that `.env` is gitignored and was removed from the worktree before committing.

## Verification results

- **Task 1 gate `GATE_PASS`:** `docs/screenshots/landing.png` exists, `node --check scripts/smoke-public-routes.mjs` passes, and the script references `self-host`, `dashboard`, and `redirect`. No third-party imports (`grep -Eq "require\(|from \"[a-z]"` finds none). `landing.png` is a non-empty PNG.
- **Live smoke `SMOKE_PASS` (exit 0):** public routes 200, protected routes 307 → `/sign-in`, run against `next start` on port 3311.
- **Task 2 gate `GATE_PASS`:** README has the repo URL, the relative screenshot path, both niches, `npm run dev` quickstart, self-host + CLI/MCP pointers, `MIT`, and `robindarlington.com/contact`; `docs/writeup.md` has 77 non-blank lines (≥40) and mentions SQLite, SMTP, and Coolify/worker.
- **No fabricated metrics:** grep for `N users` / `% faster` / `trusted by` / `testimonial` across both files found none.
- **`npm test`:** 385 pass, 0 fail.
- **`npm run build`:** green (run twice — the second rebuild baked the Clerk publishable key so the app could boot for the live probe).

## Security Notes

- **T-09-01 (Elevation of Privilege) mitigated:** the smoke script is a positive regression test that `/dashboard`, `/settings/smtp`, `/api/*` do NOT return 200 signed-out — verified live (all 307 → sign-in).
- **T-09-02 (Information Disclosure) mitigated:** README links the `/self-host` page rather than re-printing secrets; no real key or `.env` value appears in README or the write-up.
- **T-09-03 (Repudiation/trust) mitigated:** only accurate claims (BYO-SMTP, AES-256-GCM at rest, verify-before-send, per-recipient records); no fabricated metrics/testimonials.
- **T-09-05 (downstream Tampering) mitigated:** README points at `packages/cli/README.md` and `/agents` for CLI/MCP snippets rather than duplicating them (avoids drifted copies).
- **T-09-SC (supply chain) accepted:** zero packages installed — screenshots use system Chrome, the smoke script uses Node's built-in `fetch`.

## Known Stubs

None. All four screenshots are real captures; no placeholder was committed.

## Next Phase Readiness

- Success criteria SC#1 (README + ≥1 relative-path screenshot + repo link) and SC#3 (write-up draft) are satisfied, and the phase now has a real route-level automated gate (`scripts/smoke-public-routes.mjs`).
- Note for Plan 04 / launch: the live smoke and screenshots were run against a Clerk **development** instance. Against a production `pk_live` instance there is no dev-browser handshake, so public routes return 200 directly (the smoke already handles both cases). No blockers.

## Self-Check: PASSED

- scripts/smoke-public-routes.mjs — FOUND
- docs/screenshots/landing.png, docs.png, self-host.png, agents.png — FOUND
- README.md — FOUND
- docs/writeup.md — FOUND
- commit cc1966b — FOUND
- commit 1a9225f — FOUND

---
*Phase: 09-launch-collateral*
*Completed: 2026-07-18*
