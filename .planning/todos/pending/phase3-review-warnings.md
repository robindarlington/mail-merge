---
created: 2026-07-13
title: "Phase 3 review warnings (non-critical) — batch hardening pass"
area: csv-upload
source: 03-REVIEW.md (post-phase code review)
severity: warning
---

CR-01 (email_column persistence) and WR-08 (worker UPLOADS_PATH) were fixed in the
autonomous fix pass. The remaining verified warnings from `03-REVIEW.md` are
queued here for a batch hardening pass (mirrors the WR-01..07 backlog pattern
from Phase 2's review):

- **WR-01/WR-02** — action seams claim "never rejects" but `arrayBuffer()` /
  `writeUpload` / `createRecipientSet` can throw; client has no try/catch →
  stuck "Reading your file…"/"Saving…" spinner. Fix: catch-all → `{kind:"unknown"}`
  + client error state. (Same shape as Phase 2's WR-02/WR-08 — consider fixing
  all spinner-lockup paths in one pass.)
- **WR-03** — `bodySizeLimit: "4mb"` == MAX_UPLOAD_BYTES exactly; no multipart
  headroom → near-4MB files die on platform 413 before the friendly error. Fix:
  bump limit to ~5mb, keep zod cap at 4MB.
- **WR-05** — trailing-comma header (Excel export) yields a `""` column: blank
  Select item colliding with radix's clear-selection sentinel, persisted into
  columns_json. Fix: filter/rename empty headers at parse.
- **WR-06** — `writeUpload` → DB-insert failure strands an orphan file. Fix:
  unlink on catch.
- **WR-04** — mime allow-list rejects CSVs with empty/`text/plain` types. Fix:
  accept by extension + content sniff, not mime alone.
- **WR-07** — save path discards typed error kind (misleading "try again" on
  session expiry).
- **WR-09** — `lib/csv` barrel runtime-exports node:fs-backed `writeUpload`,
  inviting client-bundle breakage (Phase 3 dodged it by importing the schema
  module directly). Fix: split server-only barrel.
- **WR-10** — no per-user storage quota on the volume shared with SQLite.

**How to apply:** run as a `/gsd:code-review 3 --fix` batch or fold the
spinner-lockup fixes (WR-01/02 here + Phase 2 WR-02/WR-08) into one resilience
pass before Phase 6 (background send) raises the stakes on error handling.
