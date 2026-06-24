# Feature Research

**Domain:** Self-serve BYO-SMTP CSV mail-merge web app (medium-scale, 100–1,000 recipients, plain-text, transactional/internal)
**Researched:** 2026-06-24
**Confidence:** HIGH (table-stakes & UX patterns corroborated across multiple tools: GMass, SecureMailMerge, YAMM, Mailmeteor, Listmonk, CSVBox, Unlayer)

---

## Feature Landscape

The competitive landscape splits into three camps, none of which match this product exactly:

1. **Gmail/Outlook add-ons** (Mailmeteor, YAMM, GMass, SecureMailMerge) — personalization + per-row attachments + preview/test-send are mature here, but they send over a *provider* account (OAuth), not arbitrary BYO-SMTP, and lean heavily on open/click tracking.
2. **Marketing/newsletter platforms** (Brevo, Sender, Mailchimp, Listmonk) — strong on campaign history, contact management, and analytics, but oriented to *lists* and *subscribers* with compliance baked in (unsubscribe, suppression) — explicitly **out of scope** here.
3. **BYO-SMTP relays** (ListMailer, Postal, ZoneMTA) — own-SMTP control, but infra-grade, not a guided per-row mail-merge UX.

This product sits at the intersection: the *personalization/attachment UX* of camp 1, the *campaign-history/audit* of camp 2, and the *BYO-SMTP control* of camp 3 — minus tracking, lists, and compliance. The differentiators below are mostly **operational-safety** features that the source CLI lacks (see CONCERNS.md) and that the add-on tools under-serve.

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| SMTP "Test connection" before save | Every SMTP-config UI (CyberPanel, GMass SMTP tester, febooti) has a Test Connection button; users won't trust an unvalidated config | MEDIUM | Reuse CLI's `transport.verify()`. Distinguish auth failure vs host/port/TLS failure in the error message; don't just say "failed". This is a hard gate before onboarding completes. |
| Explicit TLS/port handling (465 implicit vs 587 STARTTLS) | Inferring `secure` from port alone is a known CLI bug (CONCERNS.md); wrong guess = silent connection failure | LOW | Expose `secure`/STARTTLS as an explicit toggle, default sensibly from port but let `verify()` catch mismatch. |
| Encrypted-at-rest SMTP credentials, reused across sessions | A signed-in user expects to onboard SMTP once, not re-enter on every send | MEDIUM | PROJECT.md requirement. Password never logged/returned to client. Per-user key scope. |
| CSV upload with header detection | The defining input of the product; all tools auto-read header row as field source | LOW | Handle quoted fields, trailing commas, Windows line endings, BOM (CONCERNS.md flags CSV edge cases as high-risk untested). |
| Auto-detect the email/recipient column | CSVBox/Dromo standard: fuzzy-match "Email"/"E-mail Address" to the recipient field; user confirms | LOW–MEDIUM | Auto-suggest, let user override via dropdown. Required-field check: a recipient column must be chosen before proceeding. |
| Merge-field insertion from CSV columns | Core value; every tool (Mailchimp, Unlayer, Brevo, EmailOctopus) lets you drop column tokens into the body | MEDIUM | Autocomplete on `{{` trigger + a click-to-insert chip list of detected columns. Show tokens visually distinct from prose. |
| **Subject-line personalization** | Add-ons personalize subject as standard; CLI's failure to fill the subject is a logged bug (CONCERNS.md) | LOW | Apply the same merge to subject AND body. Do NOT repeat the CLI bug. |
| Live preview of merged rows (real data) | Universal "preview" step; users sanity-check substitution before committing | MEDIUM | Render row 1 by default; allow stepping through rows / picking a row. Flag rows with missing/empty merge values. |
| Send-whole-batch-to-one test address | CLI `--test` parity + a PROJECT.md requirement; standard "send test" in every tool | LOW | Route all messages to one address but keep per-recipient subject/body fill (fix the CLI subject bug here too). |
| **Confirmation before live send** | CLI lacks this (CONCERNS.md: a mistyped command goes live instantly); the single most important safety gate for irreversible bulk action | LOW | Modal showing recipient count + sender + first recipient + "this sends real email". Type-to-confirm or explicit checkbox. |
| Background send (survives request lifecycle) | A 100–1,000 send with throttling outlives an HTTP request; PROJECT.md constraint | HIGH | Persistent Node worker + queue (optional Redis). Job state in SQLite so it survives a worker restart. |
| Live per-recipient progress | "In Progress" + progress bar is the expected UX (ClickDimensions, bulk tools); users watch a long-running send | MEDIUM | Poll or stream (SSE) sent/failed/remaining counts + current recipient. Depends on background send. |
| Throttle/delay between sends | CLI does this to stay SMTP-friendly; BYO SMTP servers rate-limit | LOW | Carry forward inter-send delay; make it configurable (CONCERNS.md flags the hardcoded 3s constant). |
| Per-recipient success/fail status, persisted | PROJECT.md requirement; the audit trail the CLI entirely lacks (no sent-log) | MEDIUM | Each recipient row: queued → sending → sent/failed + error reason + timestamp. This IS the sent-log. |
| Campaign history (list of past sends) | PROJECT.md requirement; "what did I send, to whom, when" | MEDIUM | List view → drill into per-recipient statuses. |
| Per-row failures don't abort the batch | CLI already does this correctly; expected behavior | LOW | Catch per-row, log, continue. Surface failed count prominently at the end. |
| Recipient email validation at load time | CONCERNS.md: CLI passes unvalidated addresses to nodemailer | LOW | Regex/`validator` at upload; show count of invalid rows before send, let user exclude them. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Idempotency / resume-after-failure** | If a worker crashes or SMTP drops mid-batch, resume sends only to un-sent recipients — never double-sends. The add-on tools are weak here; CLI re-sends everyone (CONCERNS.md) | HIGH | Persist per-recipient state; on resume, skip rows already `sent`. Use a per-(campaign,recipient) idempotency key. The defining reliability differentiator. Depends on persisted per-recipient status. |
| **BYO-SMTP with no shared reputation** | User sends from their own server/domain — full deliverability control, no platform throttles, no shared blocklist risk | (covered by table-stakes SMTP onboarding) | This is the product's positioning vs Brevo/Mailchimp. Not extra work, but worth surfacing as the value prop. |
| Per-row attachments (different file per recipient) | Explicitly user-requested (PROJECT.md); most flexible attachment model. SecureMailMerge/YAMM charge for / gate this | HIGH | Pattern: an attachment column holds filename(s) per row; user uploads the referenced files; app matches by name. Handle missing-file-for-row as a validation error before send. Semicolon-separated for multiple files (SecureMailMerge convention). |
| Pre-send validation report | Before the confirm dialog: "1,000 rows, 3 invalid emails, 2 rows missing `{{company}}`, 1 attachment file not uploaded" — catch problems before they become failed sends | MEDIUM | Aggregates email validation + merge-field completeness + attachment presence into one gate. High trust payoff for low-ish cost. Depends on validation + attachments. |
| Missing-merge-value highlighting in preview | Show which rows would send an empty `{{field}}` (e.g. blank "First Name") — prevents embarrassing "Hi ," emails | LOW–MEDIUM | Flag empties during preview/validation. Cheap polish that add-ons often miss. |
| Downloadable send report (CSV of results) | Post-send, export per-recipient status as CSV for the user's own records — the audit trail CONCERNS.md says the CLI lacks | LOW | Derives directly from persisted per-recipient status. |
| Saved/reusable templates | Compose once, reuse the body+subject across campaigns | LOW–MEDIUM | Defer to v1.x unless cheap; not core to first validation. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Rich HTML / WYSIWYG formatting | "My emails look plain" | OUT OF SCOPE per PROJECT.md. Plain text avoids rendering bugs, deliverability penalties, and a huge editor surface. Editor's value is merge tokens + preview, not styling | Plain-text body with merge-field autocomplete only. |
| Open/click/reply tracking & analytics | Every marketing tool advertises it | OUT OF SCOPE-adjacent: tracking pixels hurt deliverability, raise privacy/consent issues, and pull toward the marketing-tool identity PROJECT.md explicitly rejects. The audit trail here is *send status*, not *engagement* | Per-recipient send/fail status only (delivery, not engagement). |
| Unsubscribe links / suppression lists / CAN-SPAM footer | "Isn't this required for bulk email?" | OUT OF SCOPE per PROJECT.md — BYO-SMTP to known recipients, sender owns compliance. Building it implies a marketing posture and contact-lifecycle management not in v1 | Document that the sender is responsible; revisit only if it becomes a newsletter tool. |
| Large-scale sending (1,000+/send), deliverability engineering | "Scale up" | OUT OF SCOPE per PROJECT.md — target is 100–1,000. Above that needs warmup, IP/domain reputation, SMTP rate-limit tuning, queue sharding | Keep medium-scale; a simple throttle + single worker suffices. |
| Managed/shared sending infrastructure | "Just send it for me" | OUT OF SCOPE per PROJECT.md — defeats the BYO-SMTP positioning; introduces shared-reputation deliverability risk and the app becoming an abuse vector | Every user brings their own validated SMTP. |
| Contact/list management (CRM-lite, segments, dedupe across uploads) | Newsletter tools have it | Scope creep toward list management; this product is CSV-in, send, done. Persistent contact stores invite compliance obligations | The CSV per campaign *is* the list. No persistent audience. |
| Scheduling / recurring / drip campaigns | "Send tomorrow at 9am" / "auto-send to new rows" (GMass-style) | Adds scheduler infra, timezone handling, and a recurring-state model. Not needed to validate the core one-shot send | Defer to v2+. Validate immediate send first. |
| Two-way Google Sheets sync (GMass model) | "Live data" | Couples to a third-party API and a sync model; CSV upload is simpler and matches the BYO/self-hosted ethos | One-shot CSV upload per campaign. |
| Storing recipient passwords / sensitive CSV data long-term | The origin CLI's use case was credential delivery | Security liability (CONCERNS.md: plaintext passwords in CSV). Persisting them in the app multiplies exposure | Process the CSV for the send; avoid persisting sensitive cell values beyond what's needed for status/audit. Consider purging row data after send. |

---

## Feature Dependencies

```
SMTP onboarding + "Test connection" (verify)
    └──gates──> Live send  (no send without a verified, encrypted SMTP)

CSV upload + header detection
    └──requires──> Recipient-column auto-detect/mapping
    └──feeds──> Merge-field autocomplete (columns = available tokens)
                    └──requires──> Live preview (renders tokens against real rows)
                                       └──enhances──> Missing-merge-value highlighting
    └──feeds──> Recipient email validation
                    └──feeds──> Pre-send validation report

Per-row attachments
    └──requires──> CSV column holding filenames
    └──requires──> File upload + name-matching step
    └──feeds──> Pre-send validation report (missing-file check)

Background send (worker + queue + job state)
    └──requires──> Persisted job/recipient state in SQLite
    └──enables──> Live per-recipient progress
    └──enables──> Per-recipient status persistence
                      └──enables──> Campaign history
                      └──enables──> Downloadable send report
                      └──enables──> Idempotency / resume-after-failure

Confirmation-before-live-send
    └──consumes──> Pre-send validation report (shows counts/warnings in the modal)
    └──gates──> Background send (live mode)

Test-send (batch-to-one)  ──parallels──> Live send (same fill logic, different routing)
```

### Dependency Notes

- **Live send requires verified SMTP:** Never allow a send against an unverified config — `verify()` is the gate (carries forward the CLI's pre-send check).
- **Merge autocomplete requires CSV header parse:** The available tokens *are* the detected columns; the editor can't offer autocomplete until a CSV is uploaded and parsed.
- **Progress, history, status, resume all sit on top of persisted job state:** These are not separable features — they're views/behaviors over the same per-recipient state table written by the background worker. Build the state model once; the rest are reads. This is the architectural backbone of the differentiators.
- **Idempotency/resume requires per-recipient persisted status:** You can only skip already-sent rows if you durably recorded which rows were sent — so the sent-log (table stakes) is a prerequisite for resume (differentiator).
- **Pre-send report aggregates three validators:** email validity + merge completeness + attachment presence. Each is independently cheap; the report is the unifying UI that powers the confirmation modal.
- **Test-send and live send share fill logic:** Implement subject+body merge once; test mode only changes the `to` routing. Fixing the CLI subject-fill bug fixes both paths.

---

## MVP Definition

### Launch With (v1)

The end-to-end "reliably send to every row, with confidence and a record" loop from PROJECT.md Core Value.

- [ ] **Clerk sign-in** — multi-tenant gate (PROJECT.md).
- [ ] **SMTP onboarding with live `verify()` + explicit TLS toggle** — essential trust gate; encrypted at rest, reused across sessions.
- [ ] **CSV upload + header detection + recipient-column mapping** — the product's input.
- [ ] **Plain-text editor with merge-field autocomplete (subject + body)** — core value; fixes CLI subject bug.
- [ ] **Live preview of merged rows + missing-value highlighting** — confidence before send.
- [ ] **Recipient email validation + pre-send validation report** — catch problems before they're failures.
- [ ] **Test-send to one address (CLI `--test` parity)** — PROJECT.md requirement.
- [ ] **Confirmation-before-live-send modal** — the #1 safety gap in the CLI; non-negotiable for an irreversible action.
- [ ] **Background send with throttle + live per-recipient progress** — PROJECT.md requirement.
- [ ] **Per-recipient status persisted + campaign history** — the audit trail (sent-log) the CLI lacks.
- [ ] **Idempotency / resume-after-failure** — borderline-MVP: it's the reliability differentiator and directly addresses a named CLI gap. Include if the persisted-state model (required anyway for progress/history) makes resume cheap; otherwise it's the first v1.x item.

### Add After Validation (v1.x)

- [ ] **Per-row attachments** — HIGH complexity (file upload, name-matching, missing-file validation). User-requested, but the text-only send loop validates the core first. Add once the send pipeline is proven. *(Trigger: core send loop stable + real user demand.)*
- [ ] **Downloadable send report (CSV)** — cheap once per-recipient status exists. *(Trigger: users asking "how do I keep a record?")*
- [ ] **Saved/reusable templates** — convenience. *(Trigger: repeat users re-typing the same body.)*
- [ ] **Resume-after-failure** if it didn't make v1.

### Future Consideration (v2+)

- [ ] **Scheduling / send-later** — needs scheduler infra; defer until immediate send is validated.
- [ ] **Compliance features (unsubscribe, footers)** — only if the product pivots toward marketing/newsletter (PROJECT.md: revisit-if).
- [ ] **Multiple saved SMTP profiles per user** — only if users send from several servers.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| SMTP onboarding + verify | HIGH | MEDIUM | P1 |
| Encrypted credential storage | HIGH | MEDIUM | P1 |
| CSV upload + header/recipient detection | HIGH | LOW–MEDIUM | P1 |
| Merge-field autocomplete (subject + body) | HIGH | MEDIUM | P1 |
| Live preview + missing-value highlight | HIGH | MEDIUM | P1 |
| Email validation + pre-send report | HIGH | MEDIUM | P1 |
| Test-send to one address | HIGH | LOW | P1 |
| Confirmation-before-live-send | HIGH | LOW | P1 |
| Background send + throttle | HIGH | HIGH | P1 |
| Live per-recipient progress | HIGH | MEDIUM | P1 |
| Per-recipient status + campaign history | HIGH | MEDIUM | P1 |
| Idempotency / resume-after-failure | HIGH | HIGH | P1–P2 |
| Per-row attachments | MEDIUM | HIGH | P2 |
| Downloadable send report | MEDIUM | LOW | P2 |
| Saved templates | MEDIUM | LOW–MEDIUM | P2 |
| Scheduling / recurring | LOW–MEDIUM | HIGH | P3 |

---

## Competitor Feature Analysis

| Feature | Add-ons (GMass / YAMM / Mailmeteor / SecureMailMerge) | Newsletter platforms (Brevo / Listmonk / Sender) | Our Approach |
|---------|--------------------------------------------------------|--------------------------------------------------|--------------|
| Transport | Provider account (OAuth Gmail/Outlook) | Shared/managed infra or own SMTP relay | **BYO SMTP per user, validated at onboarding** |
| SMTP validation UX | N/A (OAuth) | Config form, sometimes a test | **Live `verify()` gate, explicit TLS, clear error reasons** |
| CSV / data source | CSV or Google Sheet | List/subscriber import | **One-shot CSV upload per campaign** |
| Merge-field editor | Token autocomplete + sample preview | Merge-tag dropdown + dynamic blocks | **Plain-text autocomplete on `{{`, subject+body** |
| Preview / test-send | Standard | Standard (send test) | **Row-stepping preview + batch-to-one test** |
| Per-row attachments | Yes, often paid/gated | Rare | **Yes — filename column + uploaded files (v1.x)** |
| Background send + progress | Some (batched in browser/server) | Yes | **Persistent worker + live per-recipient progress** |
| Per-recipient status / history | Tracking-focused (opens/clicks) | Analytics dashboards | **Delivery status only (sent/failed/reason), persisted** |
| Resume / idempotency | Weak / absent | Platform-managed | **Explicit resume from persisted state (differentiator)** |
| Confirm-before-send | Varies | Varies | **Mandatory modal with counts + warnings** |
| Compliance (unsub/footer) | Yes | Yes (built-in) | **Out of scope — sender's responsibility** |
| Tracking/analytics | Yes (core selling point) | Yes | **Out of scope — anti-feature for this use case** |

**Key insight:** No single competitor occupies this exact niche. The add-ons nail personalization/attachment UX but tie you to a provider account and lean on tracking; the platforms nail history/audit but assume lists + compliance. This product's defensible position is **BYO-SMTP control + operational safety (confirm, resume, sent-log) for plain-text personalized sends** — precisely the reliability gaps the origin CLI exposed.

---

## Sources

- GMass — CSV mail merge workflow & merge tags: https://www.gmass.co/blog/csv-mail-merge/ , SMTP test tool: https://www.gmass.co/smtp-test (MEDIUM)
- SecureMailMerge — per-recipient individual attachments (filename-column + upload pattern): https://www.securemailmerge.com/help/sending-mail-merge-with-individual-attachments/ (MEDIUM)
- YAMM — personalized per-recipient attachments: https://support.yet-another-mail-merge.com/hc/en-us/articles/210735349 (MEDIUM)
- Mailmeteor — merge fields explained: https://mailmeteor.com/mail-merge/fields (MEDIUM)
- Unlayer — merge-tag autocomplete (triggered by first char) & sample preview: https://docs.unlayer.com/docs/merge-tags (MEDIUM)
- Mailchimp / EmailOctopus / Brevo — merge-tag insertion patterns (button + `{{ }}` typing + dropdown) (MEDIUM)
- CSVBox — auto-detect/column-mapping best practices (synonym matching "E-mail Address"→email, confirm/override): https://blog.csvbox.io/inside-csvbox-column-mapping/ ; Dromo — silent CSV import failures: https://dromo.io/blog/common-data-import-errors-and-how-to-fix-them (MEDIUM)
- SMTP test/verify UX (Test Connection, distinguish auth vs port vs TLS): CyberPanel https://cyberpanel.net/blog/smtp-test-tool , febooti https://www.febooti.com/products/automation-workshop/tutorials/test-smtp-connection-send-test-email.html (MEDIUM)
- Background-job idempotency / dedup store / transactional outbox patterns: https://www.digitalapplied.com/blog/background-job-queue-patterns-2026-engineering-reference ; BigBinary — email idempotency with Sidekiq: https://courses.bigbinaryacademy.com/learn-rubyonrails/handling-idempotency-when-sending-emails-using-sidekiq/ (MEDIUM)
- Listmonk / Postal / ListMailer — self-hosted & BYO-SMTP positioning (overview): https://github.com/topics/bulk-email-sender , https://openalternative.co/postal (MEDIUM)
- ClickDimensions — "In Progress" + progress bar send-status UX, no-reactivation duplicate guard: https://support.clickdimensions.com/hc/en-us/articles/115001166374 (LOW–MEDIUM)
- Internal: `.planning/PROJECT.md` (scope, constraints, requirements) and `.planning/codebase/CONCERNS.md` (CLI gaps: no idempotency, no confirm-before-send, subject not personalized, no sent-log, TLS-from-port bug, unvalidated emails) (HIGH — authoritative for this project)

---
*Feature research for: BYO-SMTP CSV mail-merge web app*
*Researched: 2026-06-24*
