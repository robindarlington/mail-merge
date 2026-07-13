---
phase: 03-csv-upload-parsing-recipient-mapping
plan: 05
subsystem: deploy
tags: [docker, coolify, staging, uploads, persistence]
requires:
  - 03-01..03-04 (CSV upload slice)
provides:
  - UPLOADS_PATH=/data/uploads runtime env wired in compose + .env.example
  - Staging deploy of the Phase-3 slice with durable upload storage
affects:
  - docker-compose.yml
  - .env.example
key-files:
  created: []
  modified:
    - docker-compose.yml
    - .env.example
decisions:
  - "No new volume — uploads reuse the existing /data named volume; storage.ts mkdirSync creates /data/uploads on demand"
metrics:
  tasks: 3
  files-modified: 2
  completed: 2026-07-13
---

# Phase 3 Plan 05: Uploads Volume Wiring + Staging Deploy Summary

**Task 1 (code, commit `5045e19`):** `UPLOADS_PATH` added as a runtime env in
`docker-compose.yml` (web + worker) and documented in `.env.example`. No new
volume — uploads land on the existing `/data` local volume. `docker compose
config` parses; grep gates green.

**Task 2 (human-action, RESOLVED):** User added `UPLOADS_PATH=/data/uploads` to
the Coolify staging app's runtime environment and redeployed from master
(`e2591fc`). Build and start succeeded.

**Task 3 (human-verify, APPROVED 2026-07-13):** User confirmed on staging that an
uploaded recipient set survives a container restart — "a restart still shows the
previously uploaded list." T-3-PERSIST verified. (User note: the saved list has
no manage/consume actions yet — expected; recipient sets are consumed by Phase 4
editor / Phase 5 send, and delete is an explicitly deferred later-phase item.)

## Deviations from Plan

None.

## Self-Check: PASSED
- docker-compose.yml + .env.example modified and committed — verified.
- Human checkpoints resolved with explicit user confirmation — recorded above.
