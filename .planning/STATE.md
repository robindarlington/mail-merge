---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Phase 08.1 context gathered
last_updated: "2026-07-17T23:22:18.934Z"
last_activity: 2026-07-17 -- Phase 08.1 planning complete
progress:
  total_phases: 11
  completed_phases: 5
  total_plans: 56
  completed_plans: 48
  percent: 45
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-24)

**Core value:** A signed-in user can reliably send a personalized email to every row of their CSV, using their own validated SMTP, with confidence (preview + test-send) and a record of exactly what was sent and to whom.
**Current focus:** Phase 8 complete — next: Phase 08.1 (Agent access: CLI + MCP)

## Current Position

Phase: 8 (Docker / Coolify Packaging + Operational Hardening) — COMPLETE (approved 2026-07-17)
Plan: 5 of 5 complete. Staging runs the Docker Compose build pack; exactly-once verified across a real redeploy; 5 platform-only failure modes found and fixed during the checkpoint (see 08-STAGING-NOTES.md).
Status: Ready to execute
Last activity: 2026-07-17 -- Phase 08.1 planning complete

Progress: [█████████░] 92%

## Performance Metrics

**Velocity:**

- Total plans completed: 23
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 5 | - | - |
| 02 | 9 | - | - |
| 03 | 5 | - | - |
| 06.1 | 4 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 4 | 2 tasks | 16 files |
| Phase 01 P02 | 9 | 2 tasks | 4 files |
| Phase 01 P03 | 12 | 1 tasks | 3 files |
| Phase 01 P04 | 14 | 2 tasks | 7 files |
| Phase 01 P05 | 4 | 3 tasks | 8 files |

## Accumulated Context

### Roadmap Evolution

- Phase 6.1 inserted after Phase 6: Multiple SMTP servers per account — register several SMTP configs, choose one per send (URGENT)
- Phase 08.1 inserted after Phase 8: Agent access: standalone CLI + MCP server (standalone-local, reuses lib/core; before Phase 9 so launch collateral documents it)

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Architecture]: Two containers (Next.js web + long-lived Node worker) share ONE WAL'd SQLite file on a named `/data` volume — the DB is the queue; no Redis for v1.
- [Architecture]: The persisted per-recipient `send_record` state machine (`pending → sent|failed`) is the linchpin — progress, history, idempotency, and the confirmation modal are all views/behaviors over it. Build it in Phase 6.
- [Security]: SMTP credentials encrypted AES-256-GCM with a runtime-injected key; password never logged or returned to the client.
- [Stack]: Drizzle ORM over better-sqlite3; explicit `secure` TLS toggle (not inferred from port); plainjob queue flagged for maturity check before Phase 6.
- [Phase ?]: [Scaffold]: Phase 1 is a single non-workspace Next.js 16 app (D-01); shared code lives in lib/, web build uses output:standalone (D-08), Node pinned to 24.
- [Phase ?]: [Stack]: plainjob pinned ^0.0.14 (published latest; STACK.md ^1 unreleased); added @types/react(-dom) and @tailwindcss/postcss as build-required deps.
- [Phase ?]: [Phase 1][Schema]: send_records & attachments carry NO userId — tenancy inherited via campaign_id FK; userId lives on the four top-level tenant tables (AUTH-02).
- [Phase ?]: [Phase 1][D-04]: lib/db/client.ts is the sole SQLite opener; WAL+busy_timeout=5000+synchronous=NORMAL+foreign_keys=ON set in one place.
- [Phase ?]: [Phase 1][Crypto]: AES-256-GCM credential helper (node:crypto only, no library) — fresh 12-byte IV per call, GCM auth tag verified on decrypt; output { enc, iv, tag } maps to smtp_configs password_enc/_iv/_tag.
- [Phase ?]: [Phase 1][Security]: CREDENTIAL_ENC_KEY loader fails closed (throws secret-free error) when key absent or != 32 bytes; key in env only (.env gitignored, .env.example placeholder), never in repo/DB volume.
- [Phase ?]: [Phase 1][Core] lib/core lifted from CLI: fill() generalized to arbitrary {{column}} over subject AND body (EDIT-03 fix); papaparse CSV with BOM/quoting/CRLF + invalid-email count (CSV-02/04); send with explicit secure boolean (no port===465) and structured sendOne { ok,messageId }/{ ok,error } contract for Phase 6 worker — pure (nodemailer+papaparse only), secret-safe (no logging, grep-enforced).
- [Phase ?]: [Phase 1][Migrations] Six v1 tables physically created on disk via committed Drizzle migration (drizzle/0000); db:migrate runner reuses the single lib/db client (D-04, no second opener).
- [Phase ?]: [Phase 1][Concurrency] Success criterion #1 proven EMPIRICALLY via a two-PROCESS smoke test (child_process.fork): overlapping cross-process read+write against the WAL'd app.db with NO SQLITE_BUSY; same-process async rejected (better-sqlite3 is synchronous).
- [Phase ?]: [Phase 1][Packaging] Docker Compose SKELETON (D-10): web + worker from one image share named volume appdata at /data; HOSTNAME=0.0.0.0; CREDENTIAL_ENC_KEY runtime-injected, never inlined; hardening deferred to Phase 8.

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- [Phase 6]: Highest-risk phase. Atomic claim, lease/heartbeat, SIGTERM handling, SSE-vs-polling, plainjob maturity, and SMTP 4xx/5xx backoff need phase-specific research. Run `/gsd:plan-phase --research-phase 6` before planning.
- [Phase 8]: Confirm the exact Coolify `stop_grace_period` Compose field behavior in the target Coolify version (version-dependent).

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260710-dzc | Apply approved go-to-market planning updates (9 items) to .planning docs and add MIT LICENSE | 2026-07-10 | 5ab57ee | [260710-dzc-apply-approved-go-to-market-planning-upd](./quick/260710-dzc-apply-approved-go-to-market-planning-upd/) |
| 260713-v0t | Fix compose-editor bugs: merge fields with spaces in column names + caret-following autocomplete popover | 2026-07-13 | 9d1ccf9 | [260713-v0t-fix-compose-editor-bugs-merge-fields-wit](./quick/260713-v0t-fix-compose-editor-bugs-merge-fields-wit/) |
| 260714-dxm | Rename Recipients page to Lists and add a CSV contents viewer (columns + rows detail page per upload) | 2026-07-14 | 892c0d9 | [260714-dxm-rename-recipients-page-to-lists-and-add-](./quick/260714-dxm-rename-recipients-page-to-lists-and-add-/) |
| 260715-r8d | Make list info editable in the UX: rename the label of a previously uploaded list (Lists page + detail + compose selector) | 2026-07-15 | cdc7a49 | [260715-r8d-make-list-info-editable-in-the-ux-allow-](./quick/260715-r8d-make-list-info-editable-in-the-ux-allow-/) |
| 260716-mdt | Add delete capability for campaigns and uploaded lists with confirm step and safe cleanup | 2026-07-16 | d7474d7 | [260716-mdt-add-delete-capability-for-campaigns-and-](./quick/260716-mdt-add-delete-capability-for-campaigns-and-/) |
| 260717-tpl | Template library scoped to lists (one-to-many list→templates): browse/reuse/delete saved templates | 2026-07-17 | 2fc2c39 | [260717-tpl-template-library-list-scoped](./quick/260717-tpl-template-library-list-scoped/) |
| 260718-tdl | One-click template open from list page into /compose + in-compose delete that clears the editor | 2026-07-18 | e11c7e3 | [260718-tdl-template-deep-link-and-compose-delete](./quick/260718-tdl-template-deep-link-and-compose-delete/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-07-17T22:45:59.495Z
Stopped at: Phase 08.1 context gathered
Resume file: .planning/phases/08.1-agent-access-standalone-cli-mcp-server-npm-installable-cli-b/08.1-CONTEXT.md
