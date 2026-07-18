---
phase: 09
slug: launch-collateral
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-19
---

# Phase 09 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (via tsx import) — existing root suite |
| **Config file** | package.json `test` script |
| **Quick run command** | `npm run build` (public routes must compile + prerender) |
| **Full suite command** | `npm test && npm run build` |
| **Estimated runtime** | ~90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm run build`
- **After every plan wave:** Run `npm test && npm run build`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

> All build/test gates are prefixed `set -o pipefail;` so a non-zero `npm` exit is never masked by the trailing `| tail` (nyquist compliance).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| T1 Open routes + flip URL | 01 | 1 | BRAND-01 | T-09-01, T-09-04 | Public allowlist regexes anchored (`^…$`); no authed route exposed; live hire-me URL set | build + grep | `set -o pipefail; npm run build 2>&1 \| tail -5 && grep anchored `/docs//self-host//agents//` regexes && grep contact URL && ! test -f middleware.ts && echo GATE_PASS` | ✅ | ⬜ pending |
| T2 Marketing shell + landing + auth-route footers | 01 | 1 | BRAND-01, SC-2, SC-4 | T-09-03 | Server-side `auth()` gate (no landing flash); footer on marketing shell AND /sign-in + /sign-up | build + grep | `set -o pipefail; rm -f app/page.tsx; npm run build 2>&1 \| tail -5 && grep "await auth()" + hero copy + SiteFooter in (marketing)/sign-in/sign-up layouts && ! test -f app/page.tsx && echo GATE_PASS` | ✅ | ⬜ pending |
| T1 /docs usage guide | 02 | 2 | BRAND-01, SC-2 | T-09-03 | Static content, neutral (non-accent) links, footer inherited from marketing layout | build + grep | `set -o pipefail; npm run build 2>&1 \| tail -5 && grep "Using Mail Merge" + href="/agents" && echo GATE_PASS` | ✅ | ⬜ pending |
| T2 /self-host env reference | 02 | 2 | BRAND-01, SC-2 | T-09-02 | Env vars documented by name/generator only; no real secret rendered | build + grep (negative) | `set -o pipefail; npm run build 2>&1 \| tail -5 && grep CREDENTIAL_ENC_KEY + "openssl rand -base64 32" && ! grep -E "sk_(test\|live)_…" && echo GATE_PASS` | ✅ | ⬜ pending |
| T3 /agents CLI + MCP | 02 | 2 | BRAND-01, SC-2 | T-09-05 | npx + mcpServers snippets verbatim from packages/cli/README.md (no drift) | build + grep parity | `set -o pipefail; npm run build 2>&1 \| tail -5 && grep verbatim npx + "mcpServers" + "-y" && echo GATE_PASS` | ✅ | ⬜ pending |
| T1 Screenshots + smoke probe | 03 | 3 | SC-1, SC-2 | T-09-01 | Route-probe asserts public 200 / authed not-200; ≥1 committed screenshot | node --check + grep + live smoke | `test -f docs/screenshots/landing.png && node --check scripts/smoke-public-routes.mjs && grep self-host/dashboard/redirect && echo GATE_PASS` (+ live `node scripts/smoke-public-routes.mjs` → `SMOKE_PASS`) | ✅ | ⬜ pending |
| T2 README + writeup | 03 | 3 | SC-1, SC-3, BRAND-01 | T-09-03 | Accurate claims only; live hire-me link; relative-path screenshot; no fabricated metrics | file + grep | `test -f README.md && test -f docs/writeup.md && grep repo link + landing.png + contact URL + MIT && [writeup ≥40 lines] && echo GATE_PASS` | ✅ | ⬜ pending |
| T1 Local gate + push | 04 | 4 | SC-5 | T-09-06, T-09-01 | Local gate green; no build-pack/compose diff before push-to-deploy | test + build + git diff | `set -o pipefail; npm test 2>&1 \| tail -3 && npm run build 2>&1 \| tail -3 && git diff --quiet HEAD -- docker-compose.yml Dockerfile && echo GATE_PASS` | ✅ | ⬜ pending |
| T2 Queue human-verify | 04 | 4 | SC-5, BRAND-01 | T-09-01 | Staging + authed checks recorded as non-blocking queued item | file + grep (+ human-check) | `test -f 09-04-SUMMARY.md && grep -qi "queued for rob" && grep "robindarlington.com/contact/" && echo GATE_PASS` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky (execution-time; all gates have an automated command, so nyquist-compliant at plan time).*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (root node:test suite + Next build). The only new automated harness is the dependency-free `scripts/smoke-public-routes.mjs` (Plan 03, Node built-in `fetch` only) — no framework install. No MISSING `<automated>` references remain.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Public routes render on staging URL signed-out | SC-5 | Needs the live Coolify deploy | Open staging `/`, `/docs`, `/self-host`, `/agents` in a private window; verify no auth redirect (optionally `SMOKE_BASE_URL=<staging-url> node scripts/smoke-public-routes.mjs`) |
| Signed-in `/` lands on dashboard | SC-2 | Needs a real Clerk session | Sign in, visit `/`, confirm redirect to `/dashboard` with no landing flash |
| Hire-me link works | BRAND-01 | External URL | Click footer link → https://robindarlington.com/contact/ loads |
| Authed-screen screenshots | SC-1 | Needs a Clerk session headlessly (not attainable in the overnight run) | Capture dashboard/compose/campaign-progress into `docs/screenshots/`; queued for Rob in Plan 04 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
</content>
