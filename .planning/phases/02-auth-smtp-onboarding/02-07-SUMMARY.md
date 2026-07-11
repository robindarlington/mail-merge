---
phase: 02-auth-smtp-onboarding
plan: 07
subsystem: deploy
tags: [docker, clerk, coolify, staging, deploy]
status: awaiting-human-checkpoint
requires:
  - "02-01..02-06 (auth + SMTP onboarding slice)"
provides:
  - "Dockerfile build-time Clerk ARGs (NEXT_PUBLIC_* inlined by next build)"
  - "docker-compose CLERK_SECRET_KEY runtime injection + NEXT_PUBLIC_* build.args fallback"
affects:
  - Dockerfile
  - docker-compose.yml
tech-stack:
  added: []
  patterns:
    - "Client-safe NEXT_PUBLIC_* Clerk vars passed as Docker build ARGs (build-time inlining, Pitfall 3)"
    - "Server-only secrets (CLERK_SECRET_KEY, CREDENTIAL_ENC_KEY) injected at runtime only, never in image layers"
key-files:
  created:
    - .planning/phases/02-auth-smtp-onboarding/02-07-SUMMARY.md
  modified:
    - Dockerfile
    - docker-compose.yml
decisions:
  - "NEXT_PUBLIC_CLERK_* declared as build-stage ARGs promoted to ENV before `RUN npm run build` so next build inlines them (Pitfall 3)"
  - "CLERK_SECRET_KEY deliberately absent from the Dockerfile; runtime-only via compose web.environment (threat T-2-BUILD mitigation)"
  - "compose web.build.args added as the Assumption-A2 fallback in case Coolify's Build-Variable toggle does not apply the ARGs"
metrics:
  duration: ~10 min (code portion)
  completed: 2026-07-11
  tasks_completed: 1
  tasks_total: 3
---

# Phase 2 Plan 07: Staging Deploy (Clerk build ARGs + runtime secret) Summary

Wired the Phase-2 slice for the standing Coolify staging deploy: the Clerk publishable key and sign-in/up URL vars are now build ARGs the Dockerfile promotes to ENV before `next build` (so they are inlined into the client bundle, Pitfall 3), while `CLERK_SECRET_KEY` stays a runtime-only env in compose and never touches an image layer. The remaining work is the human deploy + staging smoke test on the user's VPS.

## What Was Built (Task 1 — complete)

**Dockerfile (`build` stage):**
- Added `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` plus the four URL ARGs (`SIGN_IN_URL`, `SIGN_UP_URL`, `SIGN_IN_FALLBACK_REDIRECT_URL`, `SIGN_UP_FALLBACK_REDIRECT_URL`), each promoted to `ENV` immediately before `RUN npm run build`.
- URL ARGs carry sensible defaults (`/sign-in`, `/sign-up`, `/dashboard`) mirroring `.env.example`.
- Explicit comment block stating these are BUILD-TIME ONLY and that `CLERK_SECRET_KEY` is intentionally absent (must never be an ARG/ENV or image layer — threat T-2-BUILD).

**docker-compose.yml (`web` service):**
- Added `CLERK_SECRET_KEY: ${CLERK_SECRET_KEY}` to `web.environment` (runtime-only, alongside `CREDENTIAL_ENC_KEY`).
- Added a `web.build.args` block passing the five `NEXT_PUBLIC_CLERK_*` values from host env as the Assumption-A2 fallback (in case Coolify's Build-Variable toggle does not forward them). `CLERK_SECRET_KEY` is deliberately NOT in `build.args`.
- SKELETON header comments preserved; worker service untouched.

**Verification (automated, passed):**
- `node` grep assertion: Dockerfile has `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, has NO `ARG/ENV CLERK_SECRET_KEY`; compose contains `CLERK_SECRET_KEY`.
- `docker compose config` parses cleanly (`compose-valid`).

**Commit:** `5fb2d33` — feat(02-07): wire Clerk build ARGs + runtime secret for staging deploy

## Remaining Work (Tasks 2 & 3 — human checkpoints, blocking)

These are `checkpoint:human-action` / `checkpoint:human-verify` gates that require the user's Coolify dashboard + VPS and cannot be automated by an agent. The plan is NOT fully complete until they are done.

### Task 2 — Deploy to Coolify staging (human-action)
On the Coolify dashboard, create/point the staging application at this repo/compose, then:
- **BUILD VARIABLES** (so `next build` inlines them — Pitfall 3): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (pk_test_ from the Clerk DEV instance, D-13), `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard`.
- **RUNTIME environment**: `CLERK_SECRET_KEY` (sk_test_), `CREDENTIAL_ENC_KEY` (`openssl rand -base64 32`), `DATABASE_PATH=/data/app.db`, `HOSTNAME=0.0.0.0`.
- Deploy. If the build fails with "Missing publishableKey", the Build-Variable toggle did not apply — the compose `web.build.args` fallback is already in place; ensure the same `NEXT_PUBLIC_*` values are present in the build environment.
- Confirm `/data` is a LOCAL host volume (WAL requirement — never NFS; threat T-2-VOL).

### Task 3 — Verify the Phase-2 slice on staging (human-verify)
On the staging URL:
1. Unauthenticated hit on a protected route redirects to `/sign-in` (Clerk dev-instance banner expected — Pitfall 8).
2. Sign up / sign in on the non-localhost domain (validates dev-instance session syncing — Pitfall 8 / Assumption A3).
3. Run the SMTP onboarding wizard against a real server: verify succeeds, config saves, test-send arrives.
4. Footer hire-me link renders; dashboard reflects verified state.
5. No SMTP password in any staging network response.

## Assumptions to Resolve at the Checkpoint
- **A2 (Coolify build vars):** Whether Coolify's "Build Variable" toggle forwards the `NEXT_PUBLIC_*` ARGs to `docker build`. Fallback (`web.build.args`) is already wired. Record the outcome when deploying.
- **A3 (dev-instance session syncing on staging):** Whether the Clerk DEV instance syncs sessions correctly on the real staging domain. Record the outcome during smoke test.
- **Staging URL:** Record the final URL here after deploy.

## Deviations from Plan

None — Task 1 executed exactly as written. The `build.args` fallback was explicitly permitted by the plan ("optionally pass the same NEXT_PUBLIC_* values via a web.build.args block as the Assumption-A2 fallback").

## Self-Check: PASSED
- Dockerfile modified and grep-asserted (build ARG present, no secret ARG/ENV) — verified.
- docker-compose.yml modified (CLERK_SECRET_KEY runtime env present) — verified.
- `docker compose config` parses — verified.
- Commit `5fb2d33` exists — verified below.
