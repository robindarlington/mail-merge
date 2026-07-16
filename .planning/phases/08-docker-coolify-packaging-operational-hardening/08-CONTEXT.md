# Phase 8: Docker / Coolify Packaging + Operational Hardening - Context

**Gathered:** 2026-07-16
**Status:** Ready for planning
**Mode:** Auto-generated (overnight autonomous run — grey areas resolved at Claude's discretion per user handoff 2026-07-15; decisions documented for morning review)

<domain>
## Phase Boundary

Package the full system (web + worker) for the Coolify VPS so data survives redeploys and an in-flight send resumes cleanly with no duplicates. Covers: production Dockerfile (one image, two entrypoints), final docker-compose.yml (/data volume, stop_grace_period or equivalent), Coolify env/secret wiring, redeploy acceptance test, WAL checkpointing + attachment-orphan cleanup routines. Out of scope: multi-node scaling, Redis, external object storage, CI pipelines.

</domain>

<decisions>
## Implementation Decisions

### Packaging (auto-decided)
- ONE image, two compose services (web/worker) with different commands — continues the phase 1 skeleton (D-10). Node pinned to 24 (matching .nvmrc); better-sqlite3 ABI pinned by building in the same base image that runs.
- Keep Coolify compose-based deployment (staging URL already standing since phase 2). Follow 08-RESEARCH.md findings on `stop_grace_period` support; if unsupported in the target Coolify version, rely on the worker's crash-safe resume (phase 6 invariant: interrupted rows never double-send) and document the residual behavior instead of fighting the platform.

### Operational routines (auto-decided)
- WAL checkpoint: periodic `wal_checkpoint(TRUNCATE)` from the worker's poll loop on a low-frequency cadence (e.g. hourly), single-writer-aware, env-tunable. No external cron dependency.
- Attachment-orphan cleanup: worker-side sweep deleting pending (never-stamped or draft-stamped) attachments older than N days (default 7) + their files; env-tunable; logged counts only, no filenames with user data in logs beyond what's already stored.

### Acceptance (auto-decided)
- The redeploy acceptance test is scripted where possible (local compose: start send → docker compose restart → assert no duplicate sends, data intact) and the Coolify staging redeploy remains the human checkpoint plan at the end (queued for the user, consistent with 06-07/07-06).

### Claude's Discretion
Everything else per 08-RESEARCH.md findings and existing conventions. No new runtime dependencies without strong justification.

</decisions>

<specifics>
## Specific Ideas

Success criteria from ROADMAP Phase 8 are authoritative. The worker's SIGTERM drain (phase 6, cooperative per-row stop) is the foundation for criterion 3 — packaging must give it enough grace time (or document the SIGKILL residual as safe due to crash-safe resume).

</specifics>

<deferred>
## Deferred Ideas

Multi-node scaling, external queue/Redis, object storage, automated backups (worth a future todo), CI/CD pipelines.

</deferred>
