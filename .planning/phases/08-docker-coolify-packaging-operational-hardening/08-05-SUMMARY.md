---
phase: 08-docker-coolify-packaging-operational-hardening
plan: 05
status: complete
completed: 2026-07-17
requirements: [SC-2, SC-5]
key_files:
  created:
    - .planning/phases/08-docker-coolify-packaging-operational-hardening/08-STAGING-NOTES.md
  modified:
    - docker/web-entrypoint.sh (root-preamble ownership repair + setpriv drop)
    - Dockerfile (COPY --chown runtime ownership; no chown -R layer; no USER directive)
    - docker-compose.yml (dual identical build blocks; worker user node; plain depends_on; one-line healthcheck)
    - worker/index.ts (in-process schema gate before the poll loop)
    - app/(app)/lists/[id]/page.tsx (graceful missing-file state)
    - components/campaign/recipient-results-table.tsx (status-aware zero-records state)
    - lib/data/campaigns.ts (delete blocks only running+live-lease)
---

# Plan 08-05 Summary — Staging deploy + human verification (APPROVED)

The Phase 8 slice is deployed to the standing Coolify staging URL under the **Docker
Compose build pack** and the operator verified all checkpoint steps: a real 24-recipient
send interrupted by a Coolify redeploy resumed automatically with **exactly-once
delivery** (24/24, zero duplicates, zero interrupted rows), all data survived the
container replacement, both maintenance routines logged their count-only lines, secrets
are wired (values never printed), and the Stop Grace Period is set to 300s.

## What the checkpoint surfaced and fixed (platform-only failure modes)

The local acceptance (08-04) proved the mechanism; staging surfaced five gaps that only
exist on the real platform — each fixed and verified during this plan:

1. Root-owned legacy volume → entrypoint ownership repair + setpriv drop (`80192cf`).
2. Ghost upload rows from the ephemeral-uploads era → graceful missing-file UX (`5ecf658`).
3. VPS build death on the `chown -R /app` layer → `COPY --chown` (`aac3b9f`).
4. Worker never deployed (healthcheck gate + image-only service + Dockerfile build pack)
   → in-process schema gate (`21c1f6f`), dual identical build blocks (`72c80e4`), and
   the Coolify resource switched to the compose build pack.
5. Undeletable queued campaigns while the worker was down → delete policy narrowed to
   running-with-live-lease (`cb82f6b`).

Full record: `08-STAGING-NOTES.md` (env table, residuals, per-test results).

## Residuals accepted

Drain log line unobservable post-hoc in Coolify's log view (outcome-verified instead);
secrets plaintext in Coolify's generated .env on the VPS host; manual backups must
copy the WAL sidecars. All documented in the staging notes.
