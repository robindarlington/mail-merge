---
phase: 09-launch-collateral
reviewed: 2026-07-19T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - app/(marketing)/agents/page.tsx
  - app/(marketing)/docs/page.tsx
  - app/(marketing)/layout.tsx
  - app/(marketing)/page.tsx
  - app/(marketing)/self-host/page.tsx
  - app/sign-in/layout.tsx
  - app/sign-up/layout.tsx
  - docs/writeup.md
  - lib/config.ts
  - proxy.ts
  - README.md
  - scripts/smoke-public-routes.mjs
findings:
  critical: 0
  warning: 5
  info: 2
  total: 7
status: fixed
fixed_at: 2026-07-19
fixes:
  fixed: 6
  deferred: 1
---

# Phase 9: Code Review Report

**Reviewed:** 2026-07-19
**Depth:** standard
**Files Reviewed:** 12
**Status:** fixed (6 of 7 findings fixed 2026-07-19; IN-02 deferred)

## Fixes Summary

| Finding | Status | Commit |
|---------|--------|--------|
| WR-01 | Fixed | `c86b928` — probe the real `/campaigns/1/export` route handler instead of nonexistent `/api/health` |
| WR-02 | Fixed | `c7b94bf` — blocked predicate is now `status >= 400 && status < 500` (or sign-in redirect); 5xx fails |
| WR-03 | Fixed | `1b26a0d` — dropped `min-h-screen` from both auth catch-all pages; footer sits at the fold |
| WR-04 | Fixed | `512049f` — /self-host now lists HOSTNAME/PORT, all six worker tunables, and the full Clerk URL set; SMTP_* exclusion called out explicitly |
| WR-05 | Fixed | `dae9de9` — README self-host section points at `/self-host` + `.env.example`; `docs/` claim removed |
| IN-01 | Fixed | `01ec1be` — unused `CardContent` import removed |
| IN-02 | Deferred | Accepted for v1 (the review's own alternative): session-aware header requires `auth()` in the marketing layout, forcing all marketing pages dynamic |

Verified post-fix: 385/385 tests pass, `npm run build` clean, and
`smoke-public-routes.mjs` run live on port 3312 — `SMOKE_PASS` against the real
server (all three protected routes 307 → sign-in), and `SMOKE_FAIL` (exit 1)
against a stub returning 500 on protected routes, proving the probe can fail.

## Summary

Reviewed the Phase 9 public marketing surface: the `(marketing)` route group (landing, /docs, /self-host, /agents), the sign-in/sign-up footer layouts, the `proxy.ts` PUBLIC_PATHS allowlist edit, the smoke-test script, README, writeup, and the HIRE_ME_URL flip.

**Security-sensitive items verified clean:**

- **PUBLIC_PATHS allowlist (`proxy.ts:30-37`)** — all six entries are anchored `^...$`. Cross-checked against the full route tree: no authed route (`/dashboard`, `/campaigns`, `/compose`, `/lists`, `/recipients`, `/settings/smtp`, `/campaigns/[id]/export`) matches any allowlist pattern, including prefix/suffix collisions. The middleware `matcher` config was not modified this phase. No over-exposure found.
- **No secrets rendered** — `/self-host` renders only env var *names* plus the `openssl rand -base64 32` generator command; README and `docs/writeup.md` contain no key values, no `.env` dumps, no credentials.
- **Session-aware landing redirect (`app/(marketing)/page.tsx:49-51`)** — `await auth()` then `redirect("/dashboard")` runs server-side before any markup, so no landing flash. `/` is on the allowlist so the middleware still runs (matcher covers `/`), making `auth()` safe here.
- **`/agents` snippet parity** — `NPX_DRY_RUN` and `MCP_CONFIG` were diffed character-for-character against `packages/cli/README.md` (lines 24 and 143-151): both match verbatim, including the `-y` flag and the `"mcp"` arg. The four tool names and the two-step confirm-token description also match the CLI README.
- Root layout is not double-wrapped: marketing/sign-in/sign-up layouts add no extra `ClerkProvider`, and `SiteFooter` renders once per surface.

The defects found are in the smoke script's assertion logic (two), the auth-page footer layout (one), and public-doc accuracy (two).

## Warnings

### WR-01: `/api/health` protection probe is vacuous — the route does not exist

**Status:** Fixed in `c86b928`

**File:** `scripts/smoke-public-routes.mjs:32`
**Issue:** `PROTECTED_ROUTES` includes `/api/health`, but there is no `app/api/` directory anywhere in the repo — the route does not exist. If the allowlist ever accidentally exposed `/api/*`, the request would fall through the middleware to Next's router and return a plain **404**, which satisfies `isBlocked` (`status >= 400`) and the probe would report `OK (gated, not 200)`. The API leg of the T-09-01 regression test can therefore never fail, regardless of what the allowlist does. The script's own header comment claims it proves `/api/*` is "STILL protected," which it does not. (The `/dashboard` and `/settings/smtp` probes are real routes and are meaningful.)
**Fix:** Probe a route handler that actually exists, e.g. the export route:
```js
const PROTECTED_ROUTES = ["/dashboard", "/settings/smtp", "/campaigns/1/export"];
```
or add a real `app/api/health/route.ts` if an API probe is wanted. If the nonexistent path is kept deliberately, the probe should distinguish "gated by middleware (redirect/401)" from "plain 404" — see WR-02.

### WR-02: Smoke script treats any status >= 400 — including 5xx — as "protected"

**Status:** Fixed in `c7b94bf`

**File:** `scripts/smoke-public-routes.mjs:110-111`
**Issue:** `const isBlocked = status === 401 || status === 403 || status >= 400;` — the `status >= 400` clause subsumes the 401/403 checks (dead code) and also classifies **5xx** as a pass. A protected route that crashes with a 500 when hit signed-out (e.g. a page that assumes a session the middleware failed to enforce) would be reported `OK (gated, not 200)`, masking both a server error and a possible gating failure. The comment on line 31 says the expected outcome is "a redirect to the sign-in page (3xx) or a 401/404/4xx" — the code does not match the comment.
**Fix:**
```js
const isBlocked = status >= 400 && status < 500;
```
This keeps 401/403/404 as acceptable denials while a 5xx fails loudly.

### WR-03: Attribution footer renders below the fold on /sign-in and /sign-up

**Status:** Fixed in `1b26a0d`

**File:** `app/sign-in/layout.tsx:14-19` (same defect in `app/sign-up/layout.tsx:13-18`)
**Issue:** The new layouts exist specifically to surface the BRAND-01 attribution footer on the auth pages ("would otherwise be missing here"). But the nested pages (`app/sign-in/[[...sign-in]]/page.tsx:10`, `app/sign-up/[[...sign-up]]/page.tsx:9`) render `<main className="flex min-h-screen ...">`. Inside the layout's `min-h-svh` column, the child's `min-h-screen` forces the content area to at least one full viewport, so `SiteFooter` is pushed entirely below the fold — the attribution/hire-me link is in the DOM but invisible without scrolling, on pages that otherwise fit in one viewport. The layout does not achieve its stated purpose visually.
**Fix:** Drop the viewport-height class from the pages now that the layout owns the column height — in both catch-all pages:
```tsx
<main className="flex flex-col items-center px-4 pt-16">
```
(the layout's `flex-1` wrapper already stretches the content region; the footer then sits at the viewport bottom).

### WR-04: /self-host claims to mirror "the complete contract" but omits roughly half of .env.example

**Status:** Fixed in `512049f` (missing variables added)

**File:** `app/(marketing)/self-host/page.tsx:80-84` (also the doc comment at lines 14-15)
**Issue:** The page states "These mirror .env.example, the complete contract" and presents itself as the environment-variable reference for self-hosters, but it lists only 4 runtime + 2 build-time variables. `.env.example` additionally defines: `HOSTNAME` (must be `0.0.0.0` in Docker — deployment-critical), `PORT`, `SEND_DELAY_MS`, `WORKER_POLL_MS`, `WORKER_LEASE_SEC`, `WAL_CHECKPOINT_MS`, `ORPHAN_SWEEP_MS`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, and both `NEXT_PUBLIC_CLERK_*_FALLBACK_REDIRECT_URL` vars. A self-hoster following this public page alone will miss the Docker bind address and every worker knob. The omission may be intentional curation, but the "mirror .env.example" framing makes the page inaccurate as shipped.
**Fix:** Either add the missing variables (at minimum `HOSTNAME`/`PORT` and a "worker tunables" group), or reword the intro to scope the claim honestly, e.g.: "The essential variables are below; `.env.example` in the repo is the complete, documented contract."

### WR-05: README points self-hosters at a docs/ directory that contains no deployment guide

**Status:** Fixed in `dae9de9`

**File:** `README.md:68-71`
**Issue:** The Self-host section claims "the [`docs/`](docs/) directory walk[s] through the Docker/Coolify deployment shape and the full environment-variable reference." `docs/` contains only `writeup.md` (a build-story blog draft with no deployment steps or env-var reference) and `screenshots/`. The promised content does not exist at the linked location; combined with WR-04, no shipped artifact actually delivers "the full environment-variable reference" except `.env.example`, which this paragraph never mentions.
**Fix:** Reword to point where the content actually lives:
```markdown
The in-app [`/self-host`](app/(marketing)/self-host/page.tsx) page walks through
the deployment shape, and [`.env.example`](.env.example) is the complete,
documented environment-variable reference (variable names and semantics only —
no secrets are ever printed).
```

## Info

### IN-01: Unused `CardContent` import on the landing page

**Status:** Fixed in `01ec1be`

**File:** `app/(marketing)/page.tsx:19`
**Issue:** `CardContent` is imported but never used (both landing cards render only `CardHeader`/`CardTitle`/`CardDescription`). No ESLint config or lint script exists in the repo, so nothing will catch this automatically.
**Fix:** Remove `CardContent` from the import.

### IN-02: Marketing header shows "Sign in" to already-signed-in visitors on /docs, /self-host, /agents

**Status:** Deferred — accepted as-is for v1 (making the header session-aware forces all marketing pages dynamic)

**File:** `app/(marketing)/layout.tsx:29-31`
**Issue:** Only the landing (`/`) redirects signed-in users; the three doc pages are intentionally readable while signed in, but the shared header unconditionally offers "Sign in." A signed-in user reading /docs gets a dead-end affordance (Clerk will bounce them straight back through the redirect).
**Fix:** Optional: make the header session-aware (`auth()` in the layout, render a "Dashboard" link when `userId` is present) — at the cost of making all marketing pages dynamic — or accept as-is for v1.

---

_Reviewed: 2026-07-19_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
