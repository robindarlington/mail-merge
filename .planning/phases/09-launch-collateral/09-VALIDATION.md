---
phase: 09
slug: launch-collateral
status: draft
nyquist_compliant: false
wave_0_complete: false
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

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by planner) | — | — | BRAND-01 | T-09-01 | public allowlist regexes anchored; no authed route exposed | build + route probe | `npm run build` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (root node:test suite + Next build). No new framework installs.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Public routes render on staging URL signed-out | SC-5 | Needs the live Coolify deploy | Open staging `/`, `/docs`, `/self-host`, `/agents` in a private window; verify no auth redirect |
| Signed-in `/` lands on dashboard | SC-2 | Needs a real Clerk session | Sign in, visit `/`, confirm redirect to `/dashboard` |
| Hire-me link works | BRAND-01 | External URL | Click footer link → https://robindarlington.com/contact/ loads |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
