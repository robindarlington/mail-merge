# Requirements: Mail Merge Web App

**Defined:** 2026-06-24
**Core Value:** A signed-in user can reliably send a personalized email to every row of their CSV, using their own validated SMTP, with confidence (preview + test-send) and a record of exactly what was sent and to whom.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Authentication

- [ ] **AUTH-01**: User can sign up and sign in via Clerk
- [ ] **AUTH-02**: All user data (SMTP config, CSVs, campaigns, attachments) is scoped to the signed-in user (multi-tenant isolation enforced on every data access)
- [ ] **AUTH-03**: Unauthenticated users are redirected to sign-in for all app routes

### SMTP Onboarding

- [ ] **SMTP-01**: User can enter their SMTP server details (host, port, username, password, from-name, from-address)
- [ ] **SMTP-02**: User sets an explicit TLS mode (implicit SSL vs STARTTLS) rather than it being inferred from the port number
- [ ] **SMTP-03**: App validates the SMTP config with a live connection check before saving, distinguishing auth failure vs host/port failure vs TLS failure in the error message
- [ ] **SMTP-04**: SMTP credentials are stored encrypted at rest (AES-256-GCM) and reused across sessions; the password is never returned to the client or written to logs
- [ ] **SMTP-05**: Onboarding completes only after a successful validation (with an optional test-send to the user's own address)

### CSV & Recipients

- [ ] **CSV-01**: User can upload a CSV file through the browser
- [ ] **CSV-02**: App parses the CSV robustly (quoted fields, BOM, Windows line endings, encoding) and detects the header row
- [ ] **CSV-03**: App auto-detects the recipient (email) column and lets the user confirm or override it
- [ ] **CSV-04**: App validates recipient email addresses at upload and reports the count of invalid rows
- [ ] **CSV-05**: Parsed recipients and detected columns are saved as a recipient set for the campaign

### Compose & Editor

- [ ] **EDIT-01**: User composes a plain-text email subject and body in an in-browser editor
- [ ] **EDIT-02**: Editor offers autocomplete / click-to-insert merge fields drawn from the uploaded CSV's columns (triggered on `{{`)
- [ ] **EDIT-03**: Merge fields are applied to BOTH subject and body (fixes the CLI's subject-not-personalized gap)
- [ ] **EDIT-04**: User can save the composed subject + body as a template for the campaign

### Preview & Validation

- [ ] **PREV-01**: User can preview merged rows rendered against real CSV data, stepping through individual rows
- [ ] **PREV-02**: Preview highlights rows that would send an empty merge value (e.g. blank `{{name}}`)
- [ ] **PREV-03**: App produces a pre-send validation report aggregating invalid emails, missing merge values, and (when applicable) missing attachment files

### Test & Confirm

- [ ] **TEST-01**: User can send the whole batch to a single test address, with per-recipient subject/body fill preserved (CLI `--test` parity)
- [ ] **TEST-02**: Before a live send, the user must pass a confirmation modal showing recipient count, sender identity, a sample recipient, and validation warnings
- [ ] **TEST-03**: A campaign can transition from draft to queued only once, guarding against duplicate submission

### Sending (Background)

- [ ] **SEND-01**: Live send runs as a background job that survives the HTTP request lifecycle and worker restarts
- [ ] **SEND-02**: One personalized email is sent per recipient over the user's SMTP, with a configurable throttle/delay between sends
- [ ] **SEND-03**: App records per-recipient send state (`pending → sending → sent`/`failed`) with error reason and timestamp
- [ ] **SEND-04**: Per-recipient failures are logged and do not abort the batch; the failed count is surfaced at the end
- [ ] **SEND-05**: User sees live per-recipient progress (sent / failed / remaining + current recipient) during a send
- [ ] **SEND-06**: A send is idempotent and resumable — after a crash or restart, only un-sent (`pending`) recipients are processed; no recipient is double-sent

### History & Records

- [ ] **HIST-01**: User can view a list of past campaigns (what was sent, to how many recipients, when)
- [ ] **HIST-02**: User can drill into a campaign to see per-recipient success/fail status and error reasons

### Attachments

- [ ] **ATCH-01**: User can attach a different file per CSV row via a filename column plus uploaded files
- [ ] **ATCH-02**: App validates that every referenced attachment file is present before allowing a send (missing file = validation error)
- [ ] **ATCH-03**: Attachment resolution is safe against path traversal and enforces per-file and per-message size limits

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Convenience

- **CONV-01**: Downloadable send report (CSV of per-recipient results)
- **CONV-02**: Saved/reusable templates across campaigns (beyond per-campaign save)
- **CONV-03**: Multiple saved SMTP profiles per user

### Scheduling

- **SCHD-01**: Schedule a send for later / send at a specific time

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Rich HTML / WYSIWYG formatting | Plain text only — editor's value is merge tokens + preview, not styling; avoids rendering/deliverability issues |
| Open/click/reply tracking & analytics | Hurts deliverability, raises privacy/consent issues, pulls toward a marketing-tool identity that's explicitly rejected |
| Unsubscribe links / suppression / CAN-SPAM footer | BYO-SMTP to known recipients; sender owns compliance. Revisit only if it becomes a newsletter tool |
| Large-scale bulk sending (1,000+/send) | Target is medium scale (100–1,000); deliverability/IP-warmup engineering deferred |
| Managed/shared sending infrastructure | Defeats BYO-SMTP positioning; introduces shared-reputation risk and abuse-vector exposure |
| Contact / list / CRM management | The CSV per campaign IS the list; persistent audiences invite compliance obligations |
| Two-way Google Sheets sync | Couples to a third-party API; one-shot CSV upload matches the self-hosted ethos |
| Long-term storage of sensitive CSV cell values | Security liability (origin use case was credential delivery); process for the send, avoid persisting sensitive values |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 2 | Pending |
| AUTH-02 | Phase 2 | Pending |
| AUTH-03 | Phase 2 | Pending |
| SMTP-01 | Phase 2 | Pending |
| SMTP-02 | Phase 2 | Pending |
| SMTP-03 | Phase 2 | Pending |
| SMTP-04 | Phase 2 | Pending |
| SMTP-05 | Phase 2 | Pending |
| CSV-01 | Phase 3 | Pending |
| CSV-02 | Phase 3 | Pending |
| CSV-03 | Phase 3 | Pending |
| CSV-04 | Phase 3 | Pending |
| CSV-05 | Phase 3 | Pending |
| EDIT-01 | Phase 4 | Pending |
| EDIT-02 | Phase 4 | Pending |
| EDIT-03 | Phase 4 | Pending |
| EDIT-04 | Phase 4 | Pending |
| PREV-01 | Phase 4 | Pending |
| PREV-02 | Phase 4 | Pending |
| PREV-03 | Phase 4 | Pending |
| TEST-01 | Phase 5 | Pending |
| TEST-02 | Phase 5 | Pending |
| TEST-03 | Phase 5 | Pending |
| SEND-01 | Phase 6 | Pending |
| SEND-02 | Phase 6 | Pending |
| SEND-03 | Phase 6 | Pending |
| SEND-04 | Phase 6 | Pending |
| SEND-05 | Phase 6 | Pending |
| SEND-06 | Phase 6 | Pending |
| HIST-01 | Phase 6 | Pending |
| HIST-02 | Phase 6 | Pending |
| ATCH-01 | Phase 7 | Pending |
| ATCH-02 | Phase 7 | Pending |
| ATCH-03 | Phase 7 | Pending |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34 (100%)
- Unmapped: 0

> Phase 1 (Foundation) and Phase 8 (Packaging) are infrastructure/operational phases with no exclusive v1 REQ-IDs. Phase 1 underpins AUTH-02 (isolation), SMTP-04 (encryption), and SEND-06 (durable state). Phase 8 hardens SEND-01/SEND-06 durability and AUTH-02 isolation in production.

---
*Requirements defined: 2026-06-24*
*Last updated: 2026-06-24 after roadmap creation (traceability populated)*
