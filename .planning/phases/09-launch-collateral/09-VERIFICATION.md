---
phase: 09-launch-collateral
verified: 2026-07-19T00:00:00Z
status: human_needed
score: 13/13 automated must-haves verified
overrides_applied: 0
mode_note: "ROADMAP.md declares mode: mvp for Phase 9, but the ROADMAP Goal field is outcome-shaped ('The project is packaged as a public, niche-framed portfolio + lead-generation artifact...'), not a valid User Story ('As a ..., I want to ..., so that ...'). Validated via gsd-sdk query user-story.validate → valid=false. Per verify-mvp-mode.md format guard, strict MVP User Flow Coverage verification was not applied; standard goal-backward verification against the 5 ROADMAP Success Criteria (merged with PLAN frontmatter must_haves) was used instead. This mismatch was already flagged by the Plan 01 executor itself ('flagged for Rob's review rather than halting the run') and is carried forward here, not re-litigated as a new gap."
human_verification:
  - test: "Open the staging URL's /, /docs, /self-host, /agents in a private/incognito window."
    expected: "Each renders directly with no auth redirect (matches local SMOKE_PASS behavior)."
    why_human: "Requires the live Coolify staging URL, which the verifier cannot reach from this sandbox. SC-5 (deployed and works on staging)."
  - test: "Sign in on staging, visit /, confirm redirect to /dashboard with no landing flash."
    expected: "Server-side redirect with no landing content flash."
    why_human: "Requires a live browser session against staging; code inspection confirms the server-side auth() gate pattern but visual no-flash behavior needs a live check."
  - test: "Click the footer 'Hire me for custom tools' link on the live staging site."
    expected: "Loads https://robindarlington.com/contact/."
    why_human: "Requires live network access to confirm the external destination resolves; code confirms the href is correct."
  - test: "Capture authed-screen screenshots (dashboard, compose, campaign progress) and add to docs/screenshots/, alongside the existing public-page captures."
    expected: "Authed screens are captured and available for use in README/portfolio material."
    why_human: "Requires a live Clerk session; cannot be captured headlessly. Queued in 09-04-SUMMARY.md as a non-blocking item."
---

# Phase 9: Launch Collateral Verification Report

**Phase Goal:** The project is packaged as a public, niche-framed portfolio + lead-generation artifact — public marketing/docs routes in the app, a README and landing copy that speak to the target niches, a "how it was built" write-up, and an in-app attribution + hire-me link.
**Verified:** 2026-07-19
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Signed-out visitor can reach `/` and see the niche-framed landing (no redirect) | ✓ VERIFIED | `app/(marketing)/page.tsx` renders hero, "Built for two jobs" (credential delivery / per-row documents), features, CTAs. Live `SMOKE_PASS`: `/` → 200 signed-out. |
| 2 | Signed-in visitor hitting `/` redirects server-side to `/dashboard` with no flash | ✓ VERIFIED (code) | `app/(marketing)/page.tsx:49-51`: `const { userId } = await auth(); if (userId) redirect("/dashboard");` runs before any markup — same idiom as `app/(app)/dashboard/page.tsx`. Live signed-in visual confirmation queued for human (staging). |
| 3 | Attribution footer with live hire-me link renders on the public landing page | ✓ VERIFIED | `app/(marketing)/layout.tsx` imports/renders `SiteFooter` after `<main>`; `components/site-footer.tsx` links `HIRE_ME_URL` = `https://robindarlington.com/contact/` (`lib/config.ts:12`, no longer `example.com/hire-me`). |
| 4 | Footer also renders on `/sign-in` and `/sign-up` (SC4 — every page, incl. auth routes outside both layout groups) | ✓ VERIFIED | `app/sign-in/layout.tsx` and `app/sign-up/layout.tsx` both import/render `SiteFooter`; WR-03 code-review fix (`1b26a0d`) removed `min-h-screen` from the nested catch-all pages so the footer sits at the fold instead of being pushed off-screen. |
| 5 | Signed-out request to `/dashboard`, `/settings/smtp`, and an API-equivalent route still redirects/4xx (allowlist not over-exposed) | ✓ VERIFIED | Live run against `next start` (port 3313): `/dashboard` → 307, `/settings/smtp` → 307, `/campaigns/1/export` → 307, all to sign-in. `proxy.ts` PUBLIC_PATHS: 6 anchored regexes (`^...$`), `clerkMiddleware` body/matcher untouched. WR-01/WR-02 review fixes (probe a real route; 5xx no longer counted as "protected") confirmed present in `scripts/smoke-public-routes.mjs`. |
| 6 | Signed-out visitor can read step-by-step usage instructions at `/docs` | ✓ VERIFIED | `app/(marketing)/docs/page.tsx` renders "Using Mail Merge" + all 7 numbered step headings (`1. Connect your SMTP server` … `7. Watch progress and download the record`) + neutral `/agents` pointer. Live `SMOKE_PASS`: `/docs` → 200. |
| 7 | Signed-out visitor can read host-your-own instructions at `/self-host` with an env-var reference | ✓ VERIFIED | `app/(marketing)/self-host/page.tsx` documents `DATABASE_PATH`, `UPLOADS_PATH`, `CREDENTIAL_ENC_KEY`, `CLERK_SECRET_KEY`, `HOSTNAME`, `PORT`, 6 worker tunables, and the full `NEXT_PUBLIC_CLERK_*` build-time set — WR-04 review fix (`512049f`) closed the "half of .env.example missing" gap. No real secret value present (`grep -Eq "sk_(test\|live)_..."` fails as expected). Live `SMOKE_PASS`: `/self-host` → 200. |
| 8 | Signed-out visitor can read CLI + MCP agent instructions at `/agents` with copy-paste-working snippets | ✓ VERIFIED | `app/(marketing)/agents/page.tsx` contains the exact npx invocation and `mcpServers` JSON. Diffed against `packages/cli/README.md`: both blocks match verbatim (package name, `-y` flag, `mcp` arg). Live `SMOKE_PASS`: `/agents` → 200. |
| 9 | A public README exists at the repo root with ≥1 screenshot and run/deploy instructions, linking the public repo | ✓ VERIFIED | `README.md` contains `https://github.com/robindarlington/mail-merge`, `![...](docs/screenshots/landing.png)` (real 1280×900 PNG, confirmed via `file`), Quickstart (`npm run dev`), Self-host + CLI/MCP pointers (WR-05-fixed to point at `/self-host` + `.env.example` instead of an empty `docs/` claim), `MIT` license section, Author/attribution section with the live hire-me link. |
| 10 | A "how it was built" write-up draft is committed at `docs/writeup.md` | ✓ VERIFIED | `docs/writeup.md` — 92 lines, substantive narrative covering the CLI→web generalization, Next.js/Clerk/SQLite/worker architecture, BYO-SMTP + AES-256-GCM, the per-recipient state-machine idempotency design, and the spec-driven build process. No fabricated metrics. |
| 11 | A route-probe smoke asserts the four public routes are reachable signed-out and authed routes stay protected | ✓ VERIFIED | `scripts/smoke-public-routes.mjs` is dependency-free (Node built-ins + global `fetch` only). Ran live in this verification session against a freshly built `next start` on port 3313: `SMOKE_PASS`, all 4 public routes 200, all 3 protected routes 307→sign-in. Post-review-fix logic confirmed: `isBlocked = status >= 400 && status < 500` (5xx now fails), probes a real route (`/campaigns/1/export`) instead of the nonexistent `/api/health`. |
| 12 | The Phase 9 slice is pushed to GitHub, triggering the Coolify compose redeploy | ✓ VERIFIED | Local `HEAD` (`50f3bce`) == `origin/master` `HEAD` — confirmed via `git rev-parse`. All Phase 9 commits (Plans 01-04 + review + fixes) are present on the remote. |
| 13 | No build-pack change is made — deploy stays on the Docker Compose build pack | ✓ VERIFIED | `git log --oneline -- docker-compose.yml Dockerfile` shows no commits in the Phase 9 range touch either file; `git diff` across the phase range is empty for both files. |
| 14 | The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there | ? UNCERTAIN (queued human item) | Push to `origin/master` confirmed (triggers redeploy per repo memory), but confirming the live URL actually serves correctly requires network access to the Coolify-hosted staging environment, which this verifier does not have. Documented as a non-blocking queued item in `09-04-SUMMARY.md`. |

**Score:** 13/13 automated-checkable truths verified. 1 truth (#14, SC-5 live confirmation) requires human access to the staging URL and is routed to human verification, not treated as a gap — consistent with the explicit non-blocking queued-item design documented in `09-04-SUMMARY.md`.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proxy.ts` | 6 anchored public-path regexes, unchanged middleware body/matcher | ✓ VERIFIED | Confirmed by direct read; anchoring present (`^...$`) on all 6 entries. |
| `lib/config.ts` | `HIRE_ME_URL` flipped to live contact URL | ✓ VERIFIED | `https://robindarlington.com/contact/`; old placeholder string absent. |
| `app/(marketing)/layout.tsx` | Shell: header + main + SiteFooter | ✓ VERIFIED | Wordmark link, outline "Sign in" button, `<main>`, `<SiteFooter />`. |
| `app/(marketing)/page.tsx` | Session-aware landing at `/` | ✓ VERIFIED | `auth()` gate + niche-framed copy, exact hero string present. |
| `app/(marketing)/docs/page.tsx` | 7-step usage guide + agents pointer | ✓ VERIFIED | All 7 headings + `/agents` link present. |
| `app/(marketing)/self-host/page.tsx` | Env-var reference, secret-safe | ✓ VERIFIED | Full `.env.example` mirror post-WR-04 fix; no real secret. |
| `app/(marketing)/agents/page.tsx` | CLI + MCP verbatim snippets | ✓ VERIFIED | Snippet parity confirmed against `packages/cli/README.md`. |
| `app/sign-in/layout.tsx` / `app/sign-up/layout.tsx` | Footer wrap on auth routes | ✓ VERIFIED | Both render `SiteFooter`; WR-03 fold fix applied. |
| `README.md` | Repo-root README w/ screenshot, quickstart, MIT, attribution | ✓ VERIFIED | All required sections present; WR-05 fix applied. |
| `docs/writeup.md` | Write-up draft, ≥40 lines | ✓ VERIFIED | 92 non-blank lines. |
| `docs/screenshots/*.png` | Real PNG captures | ✓ VERIFIED | 4 files, all real 1280×900 PNGs (verified via `file`), not placeholders. |
| `scripts/smoke-public-routes.mjs` | Dependency-free route probe | ✓ VERIFIED | Zero third-party imports; ran live, `SMOKE_PASS`. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `proxy.ts` | `app/(marketing)/*` | PUBLIC_PATHS anchored regex bypass | ✓ WIRED | Live smoke confirms both directions: public 200, protected 307. |
| `app/(marketing)/layout.tsx` | `components/site-footer.tsx` | Import + render after `<main>` | ✓ WIRED | Confirmed by read. |
| `app/sign-in/layout.tsx` / `app/sign-up/layout.tsx` | `components/site-footer.tsx` | Import + render | ✓ WIRED | Confirmed by read; WR-03 layout fix keeps it visible. |
| `components/site-footer.tsx` | `lib/config.ts` | `HIRE_ME_URL` constant | ✓ WIRED | Live value flows through unchanged component. |
| `app/(marketing)/agents/page.tsx` | `packages/cli/README.md` | Verbatim snippet copy | ✓ WIRED | Character-level match confirmed via grep diff. |
| `app/(marketing)/self-host/page.tsx` | `.env.example` | Name/semantic mirror | ✓ WIRED | All vars present post-WR-04; secret-safe. |
| `README.md` | `docs/screenshots/landing.png` | Relative-path Markdown image | ✓ WIRED | File exists, real PNG, relative path (not `/public`). |
| `scripts/smoke-public-routes.mjs` | `app/(marketing)/*` + protected routes | Live HTTP probe | ✓ WIRED | Ran live in this session, `SMOKE_PASS`. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite | `npm test` | 385 pass, 0 fail | ✓ PASS |
| Production build | `npm run build` | Compiled successfully, all routes present (`/`, `/docs`, `/self-host`, `/agents` in route table) | ✓ PASS |
| Route-probe smoke (live) | `npm run start` (port 3313) + `node scripts/smoke-public-routes.mjs` | `SMOKE_PASS`; public 200 ×4, protected 307 ×3 | ✓ PASS |
| Snippet parity `/agents` vs CLI README | `grep` diff of npx command + mcpServers JSON | Verbatim match | ✓ PASS |
| No real secret on `/self-host` | `grep -Eq "sk_(test\|live)_..."` | No match (fails as expected — good) | ✓ PASS |
| No debt markers (`TBD`/`FIXME`/`XXX`) in modified files | `grep -nE` across 12 phase-modified files | 2 matches, both legitimate narrative comments (not code stubs) — "placeholder variable names" (security note) and "this single placeholder value" (historical comment describing the already-completed BRAND-01 flip) | ✓ PASS (no blockers) |
| Push reached origin | `git rev-parse HEAD` vs `git rev-parse origin/master` | Identical (`50f3bce`) | ✓ PASS |
| No build-pack diff | `git log -- docker-compose.yml Dockerfile` (phase range) | No commits touch either file | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BRAND-01 | 09-01, 09-02, 09-03, 09-04 (all four plans declare it) | App UI displays attribution to Robin Darlington with a visible hire-me link | ✓ SATISFIED | `HIRE_ME_URL` flipped to live URL; footer renders on landing, `/docs`, `/self-host`, `/agents`, `/sign-in`, `/sign-up`, and all authed app pages (existing `app/(app)/layout.tsx`); README also carries the same attribution + link. |

No orphaned requirements — `REQUIREMENTS.md` maps only BRAND-01 to Phase 9, and it is declared and satisfied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | None found. The two `placeholder` grep hits are historical/security-note prose in comments, not live stubs (confirmed HIRE_ME_URL and the self-host page both carry real, non-placeholder values). |

The Phase 9 code review (`09-REVIEW.md`) previously found 0 Critical + 5 Warning + 2 Info findings; all 5 Warnings and 1 Info were fixed in commits `c86b928`..`01ec1be` (verified present in git history and re-confirmed directly in the current code during this verification: WR-01, WR-02, WR-03, WR-04, WR-05, IN-01 all confirmed fixed by direct file inspection above). IN-02 (session-aware header on doc pages) was explicitly deferred/accepted for v1 by the reviewer — a documented, reasoned trade-off, not a gap.

### Human Verification Required

### 1. Staging public routes signed-out (SC-5)

**Test:** Open the staging URL's `/`, `/docs`, `/self-host`, `/agents` in a private/incognito window.
**Expected:** Each renders directly with no auth redirect (matches the local `SMOKE_PASS` result verified in this session).
**Why human:** Requires network access to the live Coolify-hosted staging URL, which this verifier does not have. This is the live-confirmation leg of SC-5 ("deployed to the standing staging URL ... and works there") — the deploy-trigger half (push reached origin, no build-pack change) was verified directly.

### 2. Signed-in `/` redirect with no flash (SC-2)

**Test:** Sign in on staging, visit `/`, confirm server-side redirect to `/dashboard`.
**Expected:** No landing-page flash before the redirect.
**Why human:** Requires a live authenticated browser session; the server-side `auth()`-before-render code pattern was verified by inspection but visual flash behavior needs a live check.

### 3. Hire-me link resolves on live staging (BRAND-01)

**Test:** Click the footer "Hire me for custom tools" link on the live staging site.
**Expected:** Loads `https://robindarlington.com/contact/`.
**Why human:** Requires live network access to confirm the external URL resolves correctly from a real browser.

### 4. Authed-screen screenshots

**Test:** Capture dashboard/compose/campaign-progress screenshots from a signed-in session and add to `docs/screenshots/`.
**Expected:** Authed screens available for portfolio use.
**Why human:** Requires a live Clerk session; cannot be captured headlessly. Already explicitly queued as non-blocking in `09-04-SUMMARY.md`.

These four items were pre-identified and queued as non-blocking by the Plan 04 executor (`09-04-SUMMARY.md`, "Queued for Rob" section) and are carried forward here rather than treated as newly discovered gaps.

### Gaps Summary

No blocking gaps found. All automated/code-verifiable must-haves (13/13) pass, including live re-verification of the route-probe smoke test and all 5 code-review Warning fixes (confirmed present in the current code, not just claimed in commit messages). The only open items are the 4 human-only checks that require live staging access or a Clerk session — these were already correctly identified and queued as non-blocking by the phase's own Plan 04, and this verification confirms that classification is accurate (nothing here looks like a disguised gap).

One process note (not a gap): Phase 9 is tagged `mode: mvp` in ROADMAP.md, but the ROADMAP Goal field is outcome-shaped rather than a valid User Story. This was already self-flagged by the Plan 01 executor as "reversible... flagged for Rob's review rather than halting the run." This verification used standard goal-backward verification against the 5 numbered ROADMAP Success Criteria instead of the strict MVP User Flow Coverage format. No functional impact — worth a `/gsd mvp-phase 9` cleanup pass at Rob's convenience, but not a phase-goal-achievement blocker.

---

_Verified: 2026-07-19_
_Verifier: Claude (gsd-verifier)_
