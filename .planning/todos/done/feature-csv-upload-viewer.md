---
created: 2026-07-13
title: "Feature: view the contents of a CSV upload in the browser UX"
area: csv-uploads
source: user request (2026-07-13 session, during phase 6 planning)
severity: feature
needs_user_decision: false
---

Rob wants to open any CSV upload from the web UI and view its contents — the
columns and the rows — without re-downloading the file.

**Sketch:** add a detail view reachable from the uploads list: parse the stored
file with the existing `readUpload`/`parseCsv` (lib/csv/storage.ts, lib/core/csv.ts),
show the ordered column headers and a paginated (or capped, e.g. first N rows +
count) table of rows. Table scrolls horizontally inside the shell column per the
established UI pattern. Must stay userId-scoped (same IDOR-scoped DAL convention
as every other read).

**Notes:**
- Pairs naturally with the merge-fields-with-spaces fix: the viewer makes column
  names (incl. spaces/odd characters) visible and debuggable.
- Candidate slot: small standalone slice after Phase 6, or folded into a polish
  phase alongside the compose bug fixes.
