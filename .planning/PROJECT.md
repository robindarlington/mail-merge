# Mail Merge Web App

## What This Is

A multi-tenant web application for CSV-driven email mail merge. A signed-in user
onboards their own SMTP server and sender details (validated as functional during
onboarding), uploads a CSV, composes a plain-text email in an editor with
autocomplete merge-fields drawn from the CSV's columns, previews and test-sends
the merge, then fires a background batch that sends one personalized email per row
using their own SMTP — with live progress and a saved record of what happened.

It grows out of an existing single-file Node.js CLI script (`send-credentials.ts`)
that already performs the core merge-and-send logic for a credential-delivery use
case. This project generalizes that logic into a self-serve web product.

## Core Value

A signed-in user can reliably send a personalized email to every row of their CSV,
using their own validated SMTP, with confidence (preview + test-send) and a record
of exactly what was sent and to whom.

## Business Context

The long-horizon goal is a **portfolio + client-pipeline artifact** for Robin
Darlington's freelance "spreadsheet-to-tool" work — building, modifying, and
maintaining internal tools that replace manual spreadsheet+email processes.

- **Target niches:** IT admins / MSPs (credential delivery), per-row-document
  senders (payslips / certificates / invoices), and self-hosters (distribution).
- **Revenue rungs:** deploy-for-you, modify-for-you, and maintain-for-you
  retainers — the app is the demo; the services are the business.
- **Framing rule:** out-of-scope feature requests from users are **consulting
  leads, not product gaps**. Future phase decisions should be weighed against this
  framing — keep the product lean and let custom needs become billable work.

## Requirements

### Validated

<!-- Inferred from the existing CLI (`send-credentials.ts`) — proven merge-and-send logic to carry forward. -->

- ✓ Parse a CSV of recipients (header row + per-row values) — existing (CLI)
- ✓ Merge per-recipient values into a template via `{{field}}` substitution — existing (CLI)
- ✓ Send one personalized email per recipient over SMTP (nodemailer) — existing (CLI)
- ✓ Verify SMTP connectivity before any send — existing (CLI)
- ✓ Three-tier safety: dry-run preview, send-whole-batch-to-one test, live send — existing (CLI)
- ✓ Throttle between sends to stay friendly with the SMTP server — existing (CLI)
- ✓ Per-recipient send failures logged without aborting the batch — existing (CLI)

### Active

<!-- The web-app build. Hypotheses until shipped and validated. -->

- [ ] User can sign up / sign in via Clerk
- [ ] User onboards their SMTP server + sender details, validated live during onboarding
- [ ] User's SMTP credentials are stored encrypted at rest and reused across sessions
- [ ] User can upload a CSV file through the browser
- [ ] Editor offers autocomplete / drop-in merge-fields derived from the uploaded CSV's columns
- [ ] User composes a plain-text email body with merge-fields
- [ ] User previews merged rows in-app before sending
- [ ] User can send the whole batch to a single test address (CLI `--test` parity)
- [ ] User can attach per-row files to a send (different attachment per CSV row)
- [ ] Live send runs as a background job with live per-recipient progress
- [ ] Each send is persisted as a campaign with per-recipient success/fail status, viewable later
- [ ] A zero-setup sandbox/demo transport lets a visitor try the full flow (upload → compose → preview → "send") with no SMTP — planned for v1.x as a funnel entry point (cross-references DEMO-01)

### Out of Scope

<!-- Explicit boundaries with reasoning. -->

- Rich HTML email bodies — plain text only for v1; the editor exists for merge-field insertion, not formatting
- Email-compliance features (unsubscribe links, physical-address footer, CAN-SPAM/GDPR handling) — deferred; BYO-SMTP sending to known recipients is the sender's responsibility for now. Revisit if this becomes a marketing/newsletter tool.
- Large-scale / bulk newsletter sending (1,000+ per send) — target is medium scale (100–1,000); deliverability and SMTP rate-limit engineering deferred
- Managed/shared sending infrastructure — every user brings their own SMTP (BYO SMTP); the app never sends on a shared reputation
- PayloadCMS — only adopt if a genuine CMS need emerges; SQLite is the default backend

## Context

- **Origin:** Existing CLI script `send-credentials.ts` (Node.js + TypeScript, nodemailer, ESM, run via `node --env-file=.env`). Its merge/send logic is the reusable core. See `.planning/codebase/` for the full map.
- **Use-case shift:** The CLI was credential delivery with fixed `{{email}}`/`{{password}}` fields. The web app generalizes to arbitrary CSV columns as merge-fields.
- **Carry-forward gaps surfaced by the codebase map:** no sent-log / idempotency (re-running re-sends everyone), no confirmation before live send, subject line not personalized, hard-coded CSV path, no `.env.example`/README, no tests. The web app should address the reliability gaps (history, progress, confirmation) by design.
- **Deployment:** Self-hosted via Coolify on the user's VPS (Docker). Persistent host — long-running workers, on-disk SQLite, and an optional Redis container are all viable; no serverless function-timeout constraints.
- **Current state (Phase 1 complete):** Foundation built and verified — single Next.js 16 app scaffolded; the full v1 Drizzle schema (6 entities, the `send_record` state machine) migrated onto a WAL'd SQLite file behind one shared opener (proven concurrent-safe with a two-process no-`SQLITE_BUSY` test); AES-256-GCM credential crypto; and the lifted `lib/core` merge/send engine (subject+body `{{column}}` fill, papaparse, explicit `secure` boolean). Worker entrypoint + Docker Compose skeleton in place. UI/auth/sending logic begin in later phases.

## Constraints

- **Tech stack**: Next.js (React, full-stack) + Clerk auth + Tailwind CSS + shadcn/ui — Clerk and shadcn are React-first; Next.js keeps both first-class while reusing the existing nodemailer logic in Node.
- **Backend**: SQLite — keep it simple; adopt PayloadCMS only if a real CMS need appears.
- **Background sending**: Persistent Node worker + lightweight queue (optional Redis) — required for reliable medium-scale sends with live progress on a persistent VPS host.
- **Email transport**: nodemailer over each user's own SMTP (BYO SMTP) — reuses proven CLI transport logic; no shared sending infrastructure.
- **Email format**: Plain text only — WYSIWYG-style editor is for merge-field autocomplete + live preview, not rich formatting.
- **Security**: Per-user SMTP credentials encrypted at rest; SMTP password never committed or logged; carry forward `transport.verify()` before any send.
- **Deployment**: Coolify on VPS (containerized) — informs how the worker, web app, and SQLite volume are packaged.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Next.js + Node worker (over Laravel) | Keeps Clerk + shadcn first-class (both React); background jobs are achievable in a persistent Node worker on the VPS | ✓ Good — foundation (app + worker + shared SQLite) built & verified in Phase 1 |
| BYO SMTP per user, validated at onboarding | Mirrors CLI model; avoids shared-reputation deliverability risk; user owns compliance | — Pending |
| Background send with live progress + campaign history | Medium-scale sends (100–1,000) outlive a single request; addresses CLI's idempotency/audit gaps | — Pending |
| Plain text only for v1 | Editor's value is merge-field autocomplete + preview, not formatting; keeps scope lean | — Pending |
| Per-row attachments | User asked for it; most flexible mail-merge attachment model | — Pending |
| SQLite backend, Coolify/VPS deploy | "Keep backend simple"; persistent host makes SQLite + workers straightforward | ✓ Good — WAL'd SQLite proven concurrent-safe across web+worker in Phase 1 |
| Compliance deferred | Internal/transactional BYO-SMTP use; not a marketing tool in v1 | — Pending |
| MIT licensed | The code is the marketing; self-hosters are distribution; revenue is services | ✓ Applied 2026-07-10 |
| Scope fences kept deliberately | Plain-text-only, no tracking, no compliance machinery, 100–1,000 scale — these fences keep the product in the transactional/internal niche, exclude the cold-outreach/spam crowd, and define the boundary between product scope and billable custom work | — Standing |
| Keep Clerk despite per-client-deploy friction | Each single-tenant client deploy needs its own Clerk app; free tier covers it; revisit only if per-client deploys exceed ~5 | — Standing (revisit at >5 deploys) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-10 (go-to-market planning updates applied)*
