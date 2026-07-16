# Phase 8: Docker / Coolify Packaging + Operational Hardening - Research

**Researched:** 2026-07-16
**Domain:** Docker packaging (Next.js standalone + native module), Coolify compose deployment, SQLite ops
**Confidence:** HIGH (Coolify behavior community-verified against GitHub issues/PRs; SQLite/Next.js from official docs + existing verified codebase)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Packaging:** ONE image, two compose services (web/worker) with different commands — continues the phase 1 skeleton (D-10). Node pinned to 24 (matching .nvmrc); better-sqlite3 ABI pinned by building in the same base image that runs.
- Keep Coolify compose-based deployment (staging URL standing since phase 2). Follow this research on `stop_grace_period`; if unsupported in the target Coolify version, rely on the worker's crash-safe resume (phase 6 invariant: interrupted rows never double-send) and document the residual behavior instead of fighting the platform.
- **WAL checkpoint:** periodic `wal_checkpoint(TRUNCATE)` from the worker's poll loop on a low-frequency cadence (e.g. hourly), single-writer-aware, env-tunable. No external cron dependency.
- **Attachment-orphan cleanup:** worker-side sweep deleting pending (never-stamped or draft-stamped) attachments older than N days (default 7) + their files; env-tunable; logged counts only.
- **Acceptance:** scripted where possible (local compose: start send → restart → assert no duplicate sends, data intact); Coolify staging redeploy remains the queued human checkpoint at the end.

### Claude's Discretion
Everything else per this research and existing conventions. No new runtime dependencies without strong justification.

### Deferred Ideas (OUT OF SCOPE)
Multi-node scaling, external queue/Redis, object storage, automated backups (future todo), CI/CD pipelines.
</user_constraints>

<phase_requirements>
## Phase Requirements (ROADMAP success criteria — no exclusive v1 REQ-IDs)

| ID | Description | Research Support |
|----|-------------|------------------|
| SC-1 | One image, two entrypoints, ABI-pinned better-sqlite3, shared /data, raised stop_grace_period | Findings 1–3; Dockerfile hardening plan below |
| SC-2 | Coolify env/secrets wired (CREDENTIAL_ENC_KEY, DATABASE_PATH, Clerk keys, HOSTNAME=0.0.0.0) | Finding 5 (resolves Phase-2 Assumption A2) |
| SC-3 | Redeploy acceptance: data survives, interrupted send resumes with no duplicates | Finding 1 (grace-period paths), Pitfall 1 (restart vs stop), worker SIGTERM drain already implemented (worker/index.ts) |
| SC-4 | WAL checkpointing + attachment-orphan cleanup as defined routines | Finding 4 |
| SC-5 | Slice deployed to standing staging URL | Human checkpoint; Coolify version check (Assumption A1) |
</phase_requirements>

## Summary

The roadmap's research flag is answered: **Coolify honors graceful stop as of v4.1.0 (May 2026)**, but via a **per-application UI setting** ("Stop Grace Period", Advanced tab → Operations, 1–3600 s, default 30), not by parsing `stop_grace_period` from the compose file. Older versions (all v4.0.0-beta builds) had confirmed bugs where containers were SIGKILLed on stop/redeploy. Keep `stop_grace_period` in compose anyway (plain `docker stop` honors the container's StopTimeout that compose sets), set the UI value at the deploy checkpoint, and treat the worker's crash-safe resume as the always-correct safety net — the phase-6 drain stops between rows, so even a 30 s window is ample at SEND_DELAY_MS=1000.

The bigger *actual* risk found: the current entrypoints (`sh -c "npx tsx ... && node server.js"` and `npx tsx worker/index.ts`) put `sh`/`npx` at PID 1, which is the classic SIGTERM-swallowing pattern — the worker's carefully built drain never receives the signal reliably. Hardening = bundle the worker to `worker.js` (esbuild, `better-sqlite3` external), run both services with direct `node` in exec-form CMD, and add `init: true` in compose. No new runtime dependencies needed (esbuild arrives via existing devDeps or as one pinned devDep).

**Primary recommendation:** Same-image build+run on `node:24-bookworm-slim` (glibc, never Alpine), esbuild-bundled `worker.js` with `better-sqlite3`/`pino` external against a pruned prod `node_modules`, `init: true` + exec-form `node` CMDs, compose `stop_grace_period: 5m` + Coolify UI grace setting at checkpoint, hourly idle-aware `wal_checkpoint(TRUNCATE)` and 7-day orphan sweep inside the worker loop.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Image build / entrypoints | Dockerfile (build infra) | compose `command` | One image, service command selects entrypoint (D-10) |
| Graceful stop window | Coolify UI + compose | Worker process | Platform grants time; worker's SIGTERM handler uses it |
| Crash-safe resume | Worker + SQLite (existing) | — | Phase-6 invariant; packaging must not break it, only widen the graceful window |
| WAL checkpoint | Worker poll loop | — | Single long-lived process that knows idle windows (locked decision) |
| Orphan cleanup | Worker poll loop | — | Same tick scheduler, low cadence (locked decision) |
| Secret injection | Coolify UI → .env → compose interpolation | — | Compose file is the single source of truth for var names (Finding 5) |
| Migrations | Web entrypoint only | — | Existing decision — worker never races migrate |

## Findings

### 1. Coolify + `stop_grace_period` (the research flag) — ANSWERED

**Verified timeline** [VERIFIED: GitHub coollabsio/coolify issues/PRs]:
- **v4.0.0-beta.408 and earlier:** confirmed bug — services SIGKILLed on stop; `Service::stopContainers` used async process handling then `docker rm -f`, never respecting `stop_grace_period` ([issue #5620](https://github.com/coollabsio/coolify/issues/5620)).
- **v4.0.0-beta.418:** SIGTERM reached the app but containers were force-removed within milliseconds ([issue #5876](https://github.com/coollabsio/coolify/issues/5876)).
- **v4.1.0 (released ~May–June 2026):** [PR #9746](https://github.com/coollabsio/coolify/pull/9746) shipped in [v4.1.0 (PR #9841)](https://github.com/coollabsio/coolify/pull/9841) — adds a **per-application "Stop Grace Period" UI setting** (Advanced tab → Operations, 1–3600 s, default 30) used as `docker stop --time=<n>` in all four stop paths: rolling-update shutdown, manual stop, stop-on-another-server, preview stop. Both bug issues are closed referencing these PRs.

**Key nuance** [CITED: PR #9746 description]: the shipped fix is a **UI setting, not compose-file parsing**. Coolify passes an explicit `--time` to `docker stop`, which overrides the container's compose-derived StopTimeout. So the compose `stop_grace_period` key alone is NOT sufficient on Coolify — the UI value must be raised too.

**Recommendation (do all three):**
1. Add `stop_grace_period: "5m"` to the worker service (and `1m` web) in compose — honored by plain `docker stop` / `docker compose stop` and by any non-Coolify operation, costs nothing.
2. At the staging deploy checkpoint: confirm Coolify ≥ v4.1.0 and set the app's Stop Grace Period (suggest 300 s) in Advanced → Operations. (Assumption A1: staging instance version unknown from the repo.)
3. Regardless of platform behavior, the worker's crash-safe resume remains the correctness guarantee — a SIGKILL mid-row costs at most one already-committed send_record and zero duplicates (phase-6 invariant). Document this as the residual behavior if the Coolify version can't be upgraded.

**Sizing note:** the drain stops *between rows* — one row ≈ one SMTP send + 1 s delay, well under even the 30 s default. A large grace period mainly protects against a slow/hung SMTP connection during the in-flight row.

### 2. One image, two entrypoints + better-sqlite3 ABI

- `better-sqlite3@12.11.1` engines: `20.x || 22.x || 23.x || 24.x || 25.x || 26.x` — Node 24 supported [VERIFIED: npm view].
- **The existing pattern is already correct:** build (`npm ci` with python3/make/g++) and run in the same `node:24-bookworm-slim` base → the compiled `.node` binary ABI matches by construction. No `npm rebuild` in the runtime stage needed. Keep glibc (bookworm); **never switch to Alpine/musl** — musl prebuild variance and glibc/musl mismatch is the classic better-sqlite3 container failure [ASSUMED — widely documented, consistent with docker forums reports].
- **PID 1 / signal delivery is the real hardening gap** [ASSUMED — standard Docker/Node practice]:
  - Worker today: `npx tsx worker/index.ts` → npx is PID 1; SIGTERM delivery to the grandchild node process is unreliable, and npm-family wrappers are the canonical "container ignores SIGTERM" cause. The phase-6 drain depends on receiving SIGTERM.
  - Web today: `sh -c "npx tsx scripts/migrate.ts && node server.js"` → `sh` is PID 1; dash's tail-exec optimization *may* exec the final command but this is shell-dependent, not a guarantee.
  - Fix: (a) bundle the worker (D-07) and run `node worker.js` exec-form; (b) for web, use an entrypoint script ending in `exec node server.js` (migration still runs first, only in web); (c) add `init: true` to both compose services — Docker's built-in tini forwards signals and reaps zombies with zero image changes. Node with an installed SIGTERM handler works fine as the direct child of tini.

### 3. Next.js standalone output + better-sqlite3 / worker bundle

- `output: "standalone"` copies **traced** `node_modules` into `.next/standalone/node_modules`; `serverExternalPackages: ["better-sqlite3"]` keeps it out of the bundle but output-file-tracing (@vercel/nft) still traces and copies it — including `build/Release/better_sqlite3.node` — into the standalone folder [CITED: nextjs.org/docs/app/api-reference/config/next-config-js/output + serverExternalPackages]. Escape hatch if the binding is ever missed: `outputFileTracingIncludes: { '*': ['node_modules/better-sqlite3/**/*'] }`.
- **Current skeleton bug-in-waiting:** `COPY --from=build /app/node_modules ./node_modules` overwrites the standalone-traced node_modules with the FULL dev-inclusive tree (hundreds of MB, devDeps in prod image). Phase 8 should drop this copy.
- **Worker bundle (D-07):** bundle `worker/index.ts` with esbuild: `esbuild worker/index.ts --bundle --platform=node --format=esm --outfile=worker.js --external:better-sqlite3 --external:pino`. Keep `pino` external too — pino's transport machinery uses dynamic `require`/worker-thread files that break when bundled (stdout-only usage often bundles fine, but external is the zero-risk path) [ASSUMED — known esbuild+pino behavior]. `nodemailer`, `drizzle-orm`, `plainjob`, `zod` etc. are pure JS and bundle cleanly [ASSUMED].
- **Worker's node_modules:** add a `prod-deps` stage (`npm ci --omit=dev`) and copy that pruned tree for the worker's externals (better-sqlite3, pino), OR point the worker at the standalone folder's node_modules if tracing already includes both (better-sqlite3 yes via serverExternalPackages; pino only if a web route imports it — don't rely on that). The pruned-prod-deps stage is the deterministic choice. Result: `tsx`, `drizzle-kit`, TypeScript sources, `tsconfig.json` all leave the runtime image; `scripts/migrate.ts` gets the same esbuild treatment (`migrate.js`).

### 4. WAL checkpointing + attachment-orphan cleanup routines

**WAL** [CITED: sqlite.org/wal.html, sqlite.org/pragma.html#pragma_wal_checkpoint]:
- SQLite auto-checkpoints (PASSIVE) at ~1000 pages, but PASSIVE cannot reset the WAL while any reader is active; with two long-lived processes (web + worker) holding read snapshots, the WAL file can grow unbounded between restarts. This is exactly the long-lived-app case that needs an explicit routine.
- `PRAGMA wal_checkpoint(TRUNCATE)` waits for readers (subject to the existing `busy_timeout = 5000`), checkpoints everything, and truncates the WAL to 0 bytes. It can still return `busy = 1` without truncating if a reader holds a snapshot the whole time — **check the returned row and log it** (`connection.pragma("wal_checkpoint(TRUNCATE)")` returns `[{ busy, log, checkpointed }]`).
- **Implementation per locked decision:** in the worker poll loop, keep a `lastCheckpointAt` timestamp; when `now - last > WAL_CHECKPOINT_MS` (default 3 600 000, env-tunable via the existing `envInt` helper) AND no tick is in flight (`!inFlight` — the worker is idle, single-writer-aware), run the pragma and log `{busy, log, checkpointed}`. No cron, no new deps.

**Orphan sweep** (schema verified in lib/db/schema.ts — `attachments.campaign_id` nullable, `created_at` unix seconds, `campaigns.status`):
- Orphan definition per CONTEXT: `campaign_id IS NULL` (never stamped) OR stamped to a campaign still in `draft` status — both with `created_at < now - N days` (default 7, env `ATTACHMENT_ORPHAN_DAYS`).
- Order of operations: delete the DB row first (transactional), then `unlink` the file; a failed unlink logs and leaves a disk-only file. This is safe in reverse too — the phase-7 worker already tolerates missing attachment files gracefully (07-04), so file-then-row also degrades cleanly. Row-first is preferred because the DB is the source of truth for quota accounting (pending-bytes quota reads rows, not the directory).
- Run from the same worker idle branch as the WAL checkpoint (e.g. every `ORPHAN_SWEEP_MS`, default hourly with the 7-day age filter — cheap query). Log counts only (`{ deletedRows, deletedFiles, unlinkFailures }`), never filenames.

### 5. Coolify env/secret injection for compose apps — resolves Phase-2 Assumption A2

Community-verified [CITED: cryszon.github.io — "Environment variables and build args for Docker Compose in Coolify"; matches Coolify docs]:
- **The "Build Variable?" toggle does NOT work for Docker Compose deployments.** The Phase-2 "fallback" (`web.build.args` with `${VAR}` interpolation) is actually the **primary and only working path** — record A2 as resolved: keep `build.args`, don't rely on the toggle.
- Mechanism: every variable defined in the Coolify UI is written to a `.env` beside the compose file at deploy time; compose interpolates `${VAR}` in both `build.args` and `environment`. The compose file is the single source of truth for which vars exist — a var not referenced in compose won't reach the container.
- Mark values containing `$`, `@`, or other special characters as **"Is Literal?"** in the Coolify UI to prevent interpolation mangling (relevant to `CLERK_SECRET_KEY` / `CREDENTIAL_ENC_KEY` which are random base64).
- Security note: Coolify stores these plaintext at `/data/coolify/applications/<id>/.env` on the VPS — "locked" secrets are UI-hidden, not encrypted at rest on the host. Acceptable for this deployment; do not treat Coolify's lock as encryption.
- Existing compose already wires: build-time `NEXT_PUBLIC_CLERK_*` (client-inlined by `next build`), runtime-only `CLERK_SECRET_KEY` + `CREDENTIAL_ENC_KEY`, `DATABASE_PATH=/data/app.db`, `HOSTNAME=0.0.0.0` — SC-2 is mostly confirming + documenting, plus adding `UPLOADS_PATH` and the new worker tunables (`WAL_CHECKPOINT_MS`, `ATTACHMENT_ORPHAN_DAYS`, etc.).

## Standard Stack

| Library/Tool | Version | Purpose | Why |
|---------|---------|---------|--------------|
| node:24-bookworm-slim | 24 (LTS) | build + runtime base | glibc, matches .nvmrc, ABI pin by same-image build/run [VERIFIED: existing Dockerfile] |
| better-sqlite3 | 12.11.1 (installed ^12.11) | native driver | engines include Node 24 [VERIFIED: npm view] |
| esbuild | ~0.25 (present transitively; pin as explicit devDep) | worker/migrate bundle | already in tree via drizzle-kit/tsx; single-file `worker.js` (D-07) [VERIFIED: npm ls] |
| Docker Compose `init: true` | compose spec | PID-1 tini | zero-dependency signal forwarding [ASSUMED — compose spec standard] |
| Coolify | ≥ v4.1.0 required on VPS | stop grace UI setting | PR #9746 / release v4.1.0 [VERIFIED: GitHub] |

**No new runtime dependencies.** Only change: promote `esbuild` to an explicit pinned devDependency (it already exists transitively — deduped 0.25.12) so the build doesn't depend on a transitive hoist.

## Package Legitimacy Audit

slopcheck was not available in this environment (pip install failed silently) — per protocol, additions are tagged `[ASSUMED]` and the planner should gate any *new* install behind verification. Mitigating context: the only addition is `esbuild`, which is already present in the project's lockfile as a transitive dependency and is documented at esbuild.github.io.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| esbuild | npm | ~6 yrs | tens of M/wk | github.com/evanw/esbuild | unavailable | Approved [ASSUMED — already in lockfile transitively, official docs exist] |

**Packages removed due to [SLOP]:** none. **Flagged [SUS]:** none.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PID-1 signal forwarding | custom trap/exec shell wrapper for the worker | compose `init: true` + exec-form `node` CMD | tini handles reaping + forwarding correctly; shell traps are subtly wrong |
| TS execution in prod | shipping tsx + TS sources | esbuild bundle at build time | removes tsx/typescript from runtime image, fixes PID-1, faster start |
| WAL truncation scheduling | external cron/sidecar | worker-loop timer (locked decision) | worker already owns the idle-awareness needed |
| Duplicate-send protection during redeploy | new locking/queue machinery | existing phase-6 lease + synchronous send_records + orphan sweep | already the correctness guarantee; packaging only widens the graceful window |

## Common Pitfalls

1. **`docker compose restart` ignores `stop_grace_period`** — it always uses a 10 s timeout ([docker/compose#10670](https://github.com/docker/compose/issues/10670), open). The scripted redeploy acceptance test MUST use `docker compose stop && up -d` (or `restart -t 330`), never bare `restart`, or it tests the SIGKILL path unintentionally. (Testing the SIGKILL path *separately* with `docker kill` is actually a good extra assertion for crash-safe resume.)
2. **Coolify grace period is a UI setting, not the compose key** — compose `stop_grace_period` alone does nothing on Coolify stop/redeploy because Coolify passes explicit `docker stop --time`. Set Advanced → Operations → Stop Grace Period at the checkpoint; requires Coolify ≥ v4.1.0.
3. **`npx`/`npm`/`sh -c` as PID 1 swallows SIGTERM** — the phase-6 drain is dead code if the signal never arrives. Exec-form `node` CMDs + `init: true`.
4. **Coolify "Build Variable?" toggle is a no-op for compose apps** — use plain UI env vars + compose `build.args` interpolation (already wired; A2 resolved).
5. **Copying full build `node_modules` into the runtime image** — current skeleton line 65 ships devDeps and clobbers the traced standalone tree; replace with a pruned `npm ci --omit=dev` stage for worker externals.
6. **Alpine/musl base for better-sqlite3** — glibc/musl binding mismatch; stay on bookworm-slim for both build and run stages.
7. **`wal_checkpoint(TRUNCATE)` can silently no-op (`busy=1`)** while a reader holds a snapshot — always inspect and log the pragma's returned row; don't assume the WAL shrank.
8. **Backups/copies of `app.db` alone lose the WAL** — any manual copy must checkpoint first or copy all three files (`app.db`, `-wal`, `-shm`); note this in ops docs (automated backups deferred).
9. **Clerk `NEXT_PUBLIC_*` inlined at build** — a Coolify env-var change to the publishable key requires a rebuild, not a restart. Document at the checkpoint.
10. **Migration racing on multi-service start** — already handled (only web migrates); keep it that way when rewriting CMDs, and keep `depends_on: web` for the worker.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | local acceptance test, image build | ✓ | 28.1.1 | — |
| Docker Compose | local acceptance test | ✓ | v2.35.1-desktop | — |
| Node | build/test | ✓ | v24.9.0 (matches .nvmrc 24) | — |
| Coolify ≥ v4.1.0 | SC-1/SC-3 grace period on staging | unknown (VPS-side) | — | crash-safe resume + document residual (locked fallback) |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | node:test via tsx (`node --import tsx --test`) |
| Config file | none (glob in package.json `test` script) |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req | Behavior | Test Type | Automated Command | File Exists? |
|-----|----------|-----------|-------------------|-------------|
| SC-1 | image builds; both services start; better-sqlite3 loads | smoke | `docker compose build && docker compose up -d && docker compose logs worker` (assert "worker ready") | ❌ script Wave 0 |
| SC-3 | redeploy: no duplicate sends, data intact | integration (scripted) | new `scripts/redeploy-acceptance.ts` or shell: seed campaign → `compose stop`(not restart) → `up` → assert send_records unique per (campaign,to_addr) | ❌ Wave 0 |
| SC-4a | WAL checkpoint runs + logs result | unit | `node --import tsx --test lib/worker/*.test.ts` (checkpoint helper unit-testable against temp DB) | ❌ Wave 0 |
| SC-4b | orphan sweep deletes only aged pending/draft attachments | unit | same runner, new test file | ❌ Wave 0 |
| SC-2/SC-5 | Coolify staging env + deploy | manual-only | human checkpoint (dashboard access required) | — |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test` + `docker compose build` (compose config parse at minimum)
- **Phase gate:** full suite green + local redeploy acceptance script pass before the staging checkpoint

### Wave 0 Gaps
- [ ] unit tests for checkpoint/orphan-sweep helpers (put logic in `lib/worker/maintenance.ts` so it's testable without the loop)
- [ ] `scripts/redeploy-acceptance` (compose-driven; uses `stop`/`up`, plus an optional `docker kill` crash-path assertion)

## Security Domain

| Concern | Applies | Control |
|---------------|--------|-----------------|
| Secrets in image layers | yes | CLERK_SECRET_KEY / CREDENTIAL_ENC_KEY runtime-only (already enforced); keep out of ARG/ENV — verify with `docker history` in acceptance |
| Coolify secret storage | yes | plaintext on VPS at `/data/coolify/applications/<id>/.env` — documented residual, VPS access = secret access |
| Non-root runtime | yes | add `USER node` in runtime stage; ensure /data ownership (`chown` or compose volume perms) — standard hardening, low effort |
| DevDeps/toolchain in prod image | yes | pruned prod-deps stage removes tsx/typescript/drizzle-kit attack surface |
| Log hygiene | yes | existing pino discipline (no credentials/bodies); maintenance routines log counts only |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Staging VPS Coolify is (or can be upgraded to) ≥ v4.1.0 for the Stop Grace Period UI setting | Finding 1 | Fall back to locked decision: crash-safe resume + documented SIGKILL residual — still correct, just less graceful |
| A2 | pino/nodemailer/drizzle-orm bundle or externalize cleanly with esbuild (pino kept external to be safe) | Finding 3 | Worker bundle fails at build time — caught immediately; fallback is shipping pruned node_modules + unbundled compiled JS |
| A3 | nft tracing includes the better-sqlite3 `.node` binary in standalone output (per serverExternalPackages docs) | Finding 3 | Add `outputFileTracingIncludes` — one-line fix, caught by smoke test |
| A4 | esbuild legitimacy (slopcheck unavailable) — mitigated: already in lockfile, official project | Package Audit | Gate the explicit devDep add behind human verify if desired |
| A5 | `init: true` supported by Coolify's compose deployment path | Finding 2 | Harmless if ignored; exec-form `node` CMD alone still fixes PID-1 signal delivery |

## Open Questions (RESOLVED)

**Resolution:** The one open question below is deferred to the **08-05 staging checkpoint** for on-platform confirmation. The fallback is already locked (Finding 1 / Assumption A1 — the worker's crash-safe resume is always correct; if the VPS is < v4.1.0, document the SIGKILL residual instead of fighting the platform). This is NOT a blocker to planning or execution.

1. **Does Coolify's per-app Stop Grace Period UI setting appear for Docker-Compose build-pack applications (vs Dockerfile apps)?** PR #9746 covers the application stop paths broadly, but the UI surface for compose apps is unconfirmed. Verify at the 08-05 staging checkpoint; fallback already locked (crash-safe resume). (MEDIUM confidence it applies.)

## Sources

### Primary (HIGH confidence)
- [coollabsio/coolify issue #5620](https://github.com/coollabsio/coolify/issues/5620) — stop_grace_period bug, closed via #9746/#9841
- [coollabsio/coolify PR #9746](https://github.com/coollabsio/coolify/pull/9746) — per-app Stop Grace Period UI setting (1–3600 s), merged for v4.1.0
- [coollabsio/coolify PR #9841 / release v4.1.0](https://github.com/coollabsio/coolify/releases/tag/v4.1.0)
- [coollabsio/coolify issue #5876](https://github.com/coollabsio/coolify/issues/5876) — SIGTERM propagation bug (pre-4.1)
- [docker/compose issue #10670](https://github.com/docker/compose/issues/10670) — `compose restart` ignores stop_grace_period
- [Next.js docs — output: standalone](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [serverExternalPackages](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages)
- sqlite.org — [WAL](https://sqlite.org/wal.html), [PRAGMA wal_checkpoint](https://sqlite.org/pragma.html#pragma_wal_checkpoint)
- npm registry (`npm view`): better-sqlite3 12.11.1 engines, esbuild 0.28.1 latest / 0.25.12 in-tree
- Codebase: Dockerfile, docker-compose.yml, worker/index.ts, lib/db/client.ts, lib/db/schema.ts, 02-07-SUMMARY.md

### Secondary (MEDIUM confidence)
- [Cryszon — Environment variables and build args for Docker Compose in Coolify](https://cryszon.github.io/posts/environment-variables-and-build-args-for-docker-compose-in-coolify/) — Build Variable toggle no-op for compose; .env mechanism; "Is Literal?"

### Tertiary (LOW confidence)
- General better-sqlite3-in-Docker community reports (musl/host-node_modules pitfalls) — consistent with training knowledge, marked [ASSUMED]

## Metadata

**Confidence breakdown:**
- Coolify stop_grace_period behavior: HIGH — traced to specific closed issues, merged PR, and release tag
- Docker/entrypoint/ABI hardening: HIGH — same-image pattern already proven on staging since phase 2; PID-1 fix is standard practice [ASSUMED but low-risk]
- Standalone + native module: MEDIUM-HIGH — official docs on tracing; A3 escape hatch identified
- WAL/orphan routines: HIGH — official SQLite docs + verified schema
- Coolify env injection: MEDIUM — single detailed community source, but it matches the phase-2 A2 hypothesis and Coolify docs

**Research date:** 2026-07-16
**Valid until:** ~2026-08-16 (Coolify moves fast; re-check version-specific claims if the VPS upgrades)
