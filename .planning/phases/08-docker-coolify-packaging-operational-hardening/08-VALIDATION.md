---
phase: 8
slug: docker-coolify-packaging-operational-hardening
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-16
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Populated from 08-RESEARCH.md `## Validation Architecture` + the 5 approved PLAN.md files.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (built-in) run via `node --import tsx --test` |
| **Config file** | none — glob in package.json `test` script (`lib/**/*.test.ts`; worker seams under `lib/worker/` covered automatically) |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds unit; the docker build + acceptance script (08-01/08-04) run minutes and gate the wave, not each commit |

---

## Sampling Rate

- **After every task commit:** Run `npm test` (unit seams); for infra tasks run the plan's `<automated>` verify (`docker compose config` / `docker build`).
- **After every plan wave:** `npm test` + `docker compose config` parse (minimum); Wave 2 also runs `scripts/redeploy-acceptance.sh`.
- **Before `/gsd:verify-work` (phase gate):** full suite green + local `scripts/redeploy-acceptance.sh` passes (graceful stop+up AND docker-kill crash, no double-send) BEFORE the 08-05 staging checkpoint.
- **Max feedback latency:** 60 seconds for unit seams; build/acceptance gates run per-wave.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | SC-1 | T-08-SC | esbuild promoted (no new download); `build:worker`/`build:migrate` emit resolvable ESM bundles; better-sqlite3 tracing hatch added | smoke (build) | `npm ls esbuild` + `npm run build:worker` (assert `worker.js`) | ❌ W0 script | ⬜ pending |
| 08-01-02 | 01 | 1 | SC-1 | T-08-01 / T-08-02 / T-08-03 / T-08-04 / T-08-05 | `.dockerignore` keeps host node_modules/.env/data out of context; pruned prod-deps runtime; non-root; no secret in any layer; build-arg publishable key | smoke (docker build) | `docker build --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=… .` + `docker run … require('better-sqlite3')` + `docker history` secret-free | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | SC-1 | T-08-03 | Resolved compose: `init: true`, `stop_grace_period`, exec-form `node worker.js`, tunables, shared `/data`; no `npx` entrypoint | smoke (compose config) | `docker compose config` parse + resolved-string assertions | ✅ (compose exists) | ⬜ pending |
| 08-02-02 | 02 | 1 | SC-2 | — | `.env.example` declares the full runtime + Coolify secret/literal contract incl. new worker tunables | unit (file assert) | node assert `.env.example` contains all required keys | ✅ extend | ⬜ pending |
| 08-03-01 | 03 | 1 | SC-4 | — | `checkpointWal` logs `{busy,log,checkpointed}`; `sweepOrphanAttachments` deletes only aged unstamped/draft rows, row-first then unlink, counts-only logs | unit (tdd) | `node --import tsx --test lib/worker/maintenance.test.ts` | ❌ W0 | ⬜ pending |
| 08-03-02 | 03 | 1 | SC-4 | — | Both routines wired into the worker IDLE branch, gated `!inFlight && !stopping`, env-tunable cadence | unit + grep | worker/index.ts wiring assert + `npm test` | ❌ W0 | ⬜ pending |
| 08-04-01 | 04 | 2 | SC-3 | T-08-12 / T-08-13 | Stub SMTP records every RCPT (dedup detector); harness seeds encrypted config→stub + queued campaign, asserts survival + no-duplicate | typecheck (seam) | `node --import tsx --check` on stub + harness | ❌ W0 | ⬜ pending |
| 08-04-02 | 04 | 2 | SC-3 | T-08-11 / T-08-12 / T-08-14 | Env preflight fail-fast; graceful `compose stop`+`up` (never bare restart) + `docker kill` crash; data survives, zero double-send | integration (scripted) | `bash scripts/redeploy-acceptance.sh` (exit 0) + comment-stripped grep gate | ❌ W0 | ⬜ pending |
| 08-05-01 | 05 | 3 | SC-2, SC-5 | — | Coolify env/secrets confirmed, Stop Grace Period set (or residual documented), slice redeployed to staging | manual (auto-prep) | see Manual-Only | — | ⬜ pending |
| 08-05-02 | 05 | 3 | SC-3, SC-5 | — | [CHECKPOINT human-verify] real staging redeploy mid-send resumes with data intact + no double-send; maintenance routines observed logging | manual checkpoint | see Manual-Only | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `package.json` `build:worker`/`build:migrate` esbuild scripts (emit `worker.js`/`migrate.js`) — the SC-1 build smoke depends on these (08-01)
- [ ] `.dockerignore` — prerequisite for the 08-01 Task 2 `docker build` verify AND the 08-04 acceptance build (keeps host darwin node_modules + `.env` + `/data` out of context)
- [ ] `lib/worker/maintenance.test.ts` — temp-DB unit tests: checkpoint result logging + sweep age/status selectivity + row-first ordering (SC-4) — TDD RED-first
- [ ] `scripts/stub-smtp.ts` + `scripts/acceptance-harness.ts` — RCPT-recording sink + seed/assert harness (SC-3)
- [ ] `scripts/redeploy-acceptance.sh` — compose-driven `stop`/`up` + `docker kill` crash-path acceptance, env preflight (SC-3)
- [ ] Shared fixtures: reuse the existing temp-DB + lib/data + lib/crypto seed paths from `lib/worker/recover.test.ts` (no new fixture framework)
- [ ] Framework install: none — node:test + tsx + esbuild (transitive) + smtp-server (devDep) already present

(TDD plan 08-03 creates its test RED-first during execution; `wave_0_complete` flips true when the Wave 1 TDD task + the scripted harness land.)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Coolify env/secrets wired + Stop Grace Period set | SC-2 | Requires Coolify dashboard access | 08-05 Task 1: confirm CREDENTIAL_ENC_KEY / DATABASE_PATH / Clerk keys / HOSTNAME in the Coolify UI; set Advanced → Operations → Stop Grace Period ≥300s (or document the crash-safe-resume residual if VPS < v4.1.0) |
| Slice deployed to standing staging URL, both containers healthy | SC-5 | Deployment environment | 08-05 Task 1: redeploy; verify web + worker healthy and migrations applied on the standing staging URL |
| Real staging redeploy mid-send: no double-send + data survives | SC-3, SC-5 | Requires a real Coolify redeploy of the deployed worker mid-batch | 08-05 Task 2 [checkpoint human-verify]: start a real send, trigger a Coolify redeploy mid-send, assert zero duplicate emails + interrupted rows recorded + data intact |
| WAL checkpoint + orphan sweep observed on staging | SC-4 | Requires reading live worker logs | 08-05 Task 2: confirm the maintenance routines log counts-only on the running staging worker |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a Wave 0 dependency (every plan task carries an `<automated>` block; 08-05 is the queued human checkpoint with auto-prep)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (Wave 1/2 tasks each run unit/build verifies; 08-05 manual tasks run against the auto-prepped deploy)
- [x] Wave 0 covers all MISSING references (bundle scripts, .dockerignore, maintenance test, stub+harness, acceptance script)
- [x] No watch-mode flags
- [x] Feedback latency < 60s for unit seams (build/acceptance gate per-wave, not per-commit)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-16 (back-filled from 08-RESEARCH.md `## Validation Architecture` + the 5 approved PLAN.md files during phase-8 plan revision)
</content>
