---
phase: 2
slug: auth-smtp-onboarding
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-10
source: 02-RESEARCH.md § Validation Architecture
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Promoted from 02-RESEARCH.md § Validation Architecture (Test Framework, Phase Requirements → Test Map, Sampling Rate, Wave 0 Gaps).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in `node:test` + `tsx` loader (established Phase 1; no config file, no watch mode) |
| **Config file** | none — invoked per-file |
| **Quick run command** | `node --import tsx --test <file(s)>` (+ `npx --no-install tsc --noEmit`) |
| **Full suite command** | `node --import tsx --test $(find lib -name '*.test.ts')` |
| **Estimated runtime** | ~20 seconds full suite (bounded by the smtp-server refused-port fixture asserting <15s) |

---

## Sampling Rate

- **After every task commit:** Run `node --import tsx --test <touched test files>` + `npx --no-install tsc --noEmit`
- **After every plan wave:** Run `node --import tsx --test $(find lib -name '*.test.ts')`
- **Before `/gsd:verify-work`:** Full suite green + manual wizard walkthrough (local) + staging smoke (sign-in, verify, test-send)
- **Max feedback latency:** 15 seconds (the connection-refused fixture is the slowest single case; ONBOARDING_TIMEOUTS bound it)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-01-01 | 01 | 1 | AUTH-01, AUTH-03 | T-2-SC (pkg audit) | Only audited packages installed | config-check | `node -e` deps/devDeps presence gate | ✅ package.json | ⬜ pending |
| 2-01-02 | 01 | 1 | AUTH-03 | T-2-AUTHZ | Unauthed app route → redirect; no deprecated matcher | config-check | `node -e` proxy.ts clerkMiddleware/auth.protect gate | ❌ W0 (proxy.ts) | ⬜ pending |
| 2-01-03 | 01 | 1 | AUTH-01, AUTH-03 | — | `/` redirects to protected `/dashboard` (Open Q4) | integration | `tsc --noEmit` + `node -e` ClerkProvider/redirect/HIRE_ME_URL gate | ❌ W0 (app/layout.tsx) | ⬜ pending |
| 2-01-04 | 01 | 1 | AUTH-01 | T-2-AUTHZ | Sign-up/in works end-to-end | manual-only (external IdP) | — (checkpoint:human-verify) | n/a | ⬜ pending |
| 2-02-01 | 02 | 2 | SMTP-01, SMTP-02 | T-2-SSRF | Fields validated; private-range host rejected; TLS explicit | unit | `node --import tsx --test lib/smtp/schema.test.ts` | ❌ W0 | ⬜ pending |
| 2-02-02 | 02 | 2 | SMTP-03 | T-2-CRED | Failure classified without leaking raw error | unit | `node --import tsx --test lib/smtp/errors.test.ts` | ❌ W0 | ⬜ pending |
| 2-02-03 | 02 | 2 | SMTP-03 | T-2-TLS, T-2-MITM | Fail-fast verify; auth/connection/TLS distinguished; no `rejectUnauthorized:false` | integration | `node --import tsx --test lib/smtp/verify.test.ts` (smtp-server fixtures) | ❌ W0 | ⬜ pending |
| 2-03-01 | 03 | 2 | AUTH-02, SMTP-04 | T-2-IDOR, T-2-CRED | Cross-tenant read impossible; password absent from DTO | unit/integration | `node --import tsx --test lib/data/smtp.test.ts lib/data/dto.test.ts` | ❌ W0 | ⬜ pending |
| 2-03-02 | 03 | 2 | AUTH-02 | T-2-IDOR | Unique index on `smtp_configs.user_id` (upsert conflict target, Open Q2) | migration-check | `npm run db:generate && npm run db:migrate` + `node -e` index-on-disk gate | ❌ W0 (migration) | ⬜ pending |
| 2-04-01 | 04 | 3 | AUTH-01 | — | Shell renders UserButton, footer attribution, SMTP nav slot | integration | `tsc --noEmit` + `node -e` shell gate | ❌ W0 (app shell) | ⬜ pending |
| 2-04-02 | 04 | 3 | AUTH-01 | — | Dashboard soft-gate CTA + config fetch present | integration | `tsc --noEmit` + `node -e` dashboard gate | ❌ W0 (dashboard) | ⬜ pending |
| 2-04-03 | 04 | 3 | AUTH-01 | — | Shell + soft-gate render correctly | manual-only (visual) | — (checkpoint:human-verify) | n/a | ⬜ pending |
| 2-05-01 | 05 | 3 | SMTP-05, AUTH-02, SMTP-04 | T-2-CRED, T-2-IDOR, T-2-VERIFY, T-2-SPAM | Save only after verify; verified_at semantics; userId re-derived; no secret in returns | unit | `node --import tsx --test lib/smtp/actions.test.ts` | ❌ W0 | ⬜ pending |
| 2-05-02 | 05 | 3 | SMTP-05, SMTP-04 | T-2-CRED | Test-send verifies transport then sends; result carries message string only | unit | `node --import tsx --test lib/smtp/actions.test.ts` | ❌ W0 | ⬜ pending |
| 2-06-01 | 06 | 4 | SMTP-01, SMTP-02 | T-2-CRED | RHF+zod form; TLS radio; edit prefill never carries password | integration | `tsc --noEmit` + `node -e` step-1 gate | ❌ W0 (wizard) | ⬜ pending |
| 2-06-02 | 06 | 4 | SMTP-05 | T-2-VERIFY | Verify path + from-only edit path + skippable test-send wired | integration | `tsc --noEmit` + `node -e` step-2/3 gate | ❌ W0 (wizard) | ⬜ pending |
| 2-06-03 | 06 | 4 | SMTP-01, SMTP-02, SMTP-05 | T-2-CRED | Full wizard + edit flow against a real SMTP server | manual-only (interactive) | — (checkpoint:human-verify) | n/a | ⬜ pending |
| 2-07-01 | 07 | 5 | AUTH-01, AUTH-03 | T-2-BUILD | Publishable key as build ARG; secret NOT a build arg/env | config-check | `node -e` Dockerfile/compose gate + `docker compose config` | ❌ W0 (Dockerfile) | ⬜ pending |
| 2-07-02 | 07 | 5 | SMTP-05 | — | Coolify staging deploy (build vars + runtime secrets, Open Q3) | manual-only (external infra) | — (checkpoint:human-action) | n/a | ⬜ pending |
| 2-07-03 | 07 | 5 | AUTH-01, AUTH-03, SMTP-05 | — | Phase-2 slice works on staging URL | manual-only (smoke) | — (checkpoint:human-verify) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Requirement → Test coverage (from RESEARCH § Phase Requirements → Test Map):**

| Req ID | Behavior | Coverage |
|--------|----------|----------|
| AUTH-01 | Sign-up/sign-in via Clerk works | manual-only (external IdP; prebuilt components) — 2-01-04, 2-07-03 |
| AUTH-02 | DAL scoped by userId; cross-tenant read impossible | `lib/data/smtp.test.ts` (two userIds vs temp DB) — 2-03-01 |
| AUTH-03 | Unauthed app route → redirect to /sign-in | proxy gate + `curl -sI /dashboard \| grep location:.*sign-in` — 2-01-02 |
| SMTP-01 | Form fields validated (host/port/user/pass/from) | `lib/smtp/schema.test.ts` — 2-02-01 |
| SMTP-02 | `secure` stored explicitly; transport uses it verbatim | `lib/core/send.test.ts` (partial) + schema test — 2-02-01 |
| SMTP-03 | verify distinguishes auth vs host/port vs TLS; fails fast | `lib/smtp/errors.test.ts` + `lib/smtp/verify.test.ts` — 2-02-02/03 |
| SMTP-04 | Password never in DTO/action results/logs | `lib/data/dto.test.ts` + `lib/smtp/actions.test.ts` redaction + grep gate — 2-03-01, 2-05-* |
| SMTP-05 | Save only after verify; verified_at incl. D-08 clearing | `lib/smtp/actions.test.ts` (injected verify seam) — 2-05-01 |

---

## Wave 0 Requirements

The test-first scaffolds below are the RED half of their owning plan's first task (test-first ordering). Each MISSING reference is assigned to an early-wave plan, so Wave 0 is fully mapped:

- [ ] `lib/smtp/schema.test.ts` — SMTP-01/SMTP-02 (zod schema) → plan 02-02 Task 1
- [ ] `lib/smtp/errors.test.ts` — SMTP-03 (classifier, table-driven) → plan 02-02 Task 2
- [ ] `lib/smtp/verify.test.ts` — SMTP-03/D-05 (smtp-server fixtures; pins TLS-shape assumption A1) → plan 02-02 Task 3
- [ ] `lib/data/smtp.test.ts` — AUTH-02 (cross-tenant isolation vs temp DB) → plan 02-03 Task 1
- [ ] `lib/data/dto.test.ts` — SMTP-04 (redaction assertion) → plan 02-03 Task 1
- [ ] `lib/smtp/actions.test.ts` — SMTP-05/SMTP-04 (verified_at semantics + redaction, injected seam) → plan 02-05 Tasks 1–2
- [ ] Framework install: `npm i -D smtp-server @types/smtp-server` (only new test infra) → plan 02-01 Task 1

*`lib/crypto/crypto.test.ts` and `lib/core/send.test.ts` already exist from Phase 1 and are the house-style reference (dynamic-import + temp env pattern).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Clerk sign-up / sign-in | AUTH-01 | External IdP; Clerk-hosted prebuilt flow, no unit surface | Sign up + sign in on local `next dev`, then on staging URL |
| App shell + dashboard soft-gate render | AUTH-01 | Visual layout correctness | Load `/dashboard` signed-in; confirm soft-gate callout (fresh) / summary card (configured) |
| Full wizard + edit flow | SMTP-01/02/05 | Interactive, requires a real SMTP server | Walk step 1→2→3 with real creds; verify, test-send, then edit (from-only vs connection change) |
| Coolify staging deploy | (deploy criterion) | User's external infrastructure; ports/proxy resolved on the instance (Open Q3) | Deploy via Coolify with build vars + runtime secrets; confirm image builds with publishable key |
| Staging smoke | AUTH-01/03, SMTP-05 | End-to-end on the real host | Sign in, verify SMTP, send a test email on the staging URL |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a documented manual-only justification with Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive automated-eligible tasks without automated verify (manual-only tasks are external-IdP/infra/visual, justified above)
- [x] Wave 0 covers all MISSING references (each scaffold assigned to an early-wave plan task)
- [x] No watch-mode flags (all commands are single-shot `node:test` runs)
- [x] Feedback latency < 15s (bounded by ONBOARDING_TIMEOUTS refused-port fixture)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
