# Phase 7: Per-Row Attachments - Context

**Gathered:** 2026-07-15
**Status:** Ready for planning
**Mode:** Auto-generated (overnight autonomous run — grey areas resolved at Claude's discretion per user handoff 2026-07-15; user asleep, decisions documented for morning review)

<domain>
## Phase Boundary

A user can attach a different file per CSV row, with attachments resolved safely and validated as present before any send. Covers: attachment upload UI on the compose flow, an attachments storage + DAL layer (the `attachments` table already exists in the v1 schema, tenancy inherited via campaign FK per AUTH-02 decision), pre-send presence validation as a blocking error, and the worker attaching the correct file per recipient at send time. Out of scope: rich attachment editing, cloud storage backends, attachment reuse across campaigns.

</domain>

<decisions>
## Implementation Decisions

### Matching model (auto-decided)
- The CSV designates attachments via a **filename column** (mirrors the email-column pattern from Phase 3: auto-detect a likely column, e.g. `attachment`/`file`, user confirms/overrides in the UI). A row's cell value is matched against the **original filenames of files the user uploads** for that campaign.
- Rows with an empty attachment cell send WITHOUT an attachment (not an error). Rows whose cell references a file that was NOT uploaded are a **blocking validation error before send** (success criterion 2).

### Upload & storage (auto-decided)
- Multi-file picker upload (no zip ingestion in v1) into the existing `UPLOADS_PATH` volume, stored under **opaque server-generated IDs** (never the client filename on disk) — mirrors the Phase 3 traversal-proof storage writer pattern. Original filename kept as a DB column for matching + display only.
- Enforce **per-file limit 10 MB** and **per-message limit 15 MB** (file sizes summed per row at validation time); both constants centralized so Phase 8/ops can tune via env later.

### Send path (auto-decided)
- The worker resolves attachments by DB id → opaque storage path (never a CSV-provided path); nodemailer `attachments: [{ filename: original_name, path: storagePath }]`. Missing file on disk at send time = that row fails `failed (rejected: attachment missing)` — never crashes the campaign (poison-pill lesson from Phase 6).

### Validation surface (auto-decided)
- Presence + size validation runs server-side in the existing preview/confirm pipeline (extends `previewCampaign`/confirm summary) so the confirm gate shows attachment counts and blocks on missing files — consistent with the server-authoritative validation pattern from Phases 4–5.

### Claude's Discretion
All remaining choices (exact UI composition, empty-state copy, table columns) follow existing app conventions: shadcn components, csv-uploader analog patterns, UI-SPEC to be generated for the frontend slice.

</decisions>

<specifics>
## Specific Ideas

Follow the CSV upload flow's confirm-column UX as the closest analog. Attachment upload lives on the compose page (campaign-scoped), gated after a recipient list is selected.

</specifics>

<deferred>
## Deferred Ideas

- Zip bulk upload; cloud/object storage; attachment templates per campaign; per-recipient attachment preview rendering.

</deferred>
