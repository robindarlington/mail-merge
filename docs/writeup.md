# How I built Mail Merge: from a one-off CLI to a self-serve web product

_A working draft. I publish the edited version manually at
robindarlington.com/thoughts/._

## It started as a script

Mail Merge began life as a single TypeScript file, `send-credentials.ts`. It did
one narrow job: read a CSV of people, fill a plain-text template with each row's
values, and send one personalized email per row through an SMTP server. I wrote
it because I needed to deliver a batch of individual credentials — one login per
recipient — and a shared inbox or a "Dear all" blast was exactly the wrong shape
for that.

The script was deliberately small. No web framework, no build step: Node runs
the `.ts` file directly. It had three modes — a dry run that connects to nothing,
a test mode that sends the whole batch to one address so you can proof it, and a
live send — and it verified the SMTP connection with `transport.verify()` before
it sent anything, so a bad host or password failed fast instead of half-way
through the list. Those instincts — proof before you send, verify before you
trust, one email per row — survived into everything that came after.

## Why generalize it

The script solved my problem, but the shape of the problem is common: someone has
a spreadsheet, and each row needs its own email, sometimes with its own
attachment. Credential delivery is one version of that. Payslips, certificates,
and invoices — a different file per person, matched from a column — are another.
The same engine handles both. That was the case for turning a personal utility
into something a signed-in user could run themselves, safely, against their own
mail server.

## The architecture choices

I kept the stack boring on purpose, because the interesting risk here is in the
sending, not the framework.

- **Next.js (full-stack) + Clerk auth.** One codebase for the UI and the
  server-side actions. Clerk handles multi-tenant sign-in so I never store a
  password; middleware protects every route except a small, explicitly
  allowlisted public marketing surface.
- **One SQLite file, in WAL mode.** No separate database server. The web app and
  a long-lived background worker share a single WAL-mode SQLite file on a Docker
  volume. WAL matters because it lets the worker write send progress while the
  web app reads it, without them blocking each other.
- **A persistent Node worker for the actual sending.** Batches don't run inside a
  request. A separate worker process claims queued campaigns, sends one email at
  a time with a configurable throttle, and writes progress back to SQLite as it
  goes. That's what makes live progress and mid-batch resume possible.
- **BYO-SMTP, credentials encrypted at rest.** Every user brings their own SMTP
  server. Those credentials are encrypted with AES-256-GCM before they touch the
  database, and the password is never logged, never returned to the browser, and
  never written into a receipt. The app fails loudly at startup if the encryption
  key is missing or the wrong length.
- **Deployed on Coolify (VPS, containerized).** Web app, worker, and the SQLite
  volume are packaged together. Two classes of config behave differently:
  build-time public keys inlined by `next build`, and runtime secrets injected
  into the container — a distinction that is easy to get wrong and worth being
  explicit about.

## The idempotency linchpin: the per-recipient record

The single most important design decision is that every recipient in a campaign
has its own durable record with a status. A send isn't "the batch went out"; it's
a state machine per row — queued, sending, sent, or failed. That record is what
gives you three things at once: live progress (count the statuses), an honest
audit trail of exactly who received what, and safe resume. If the worker crashes
or the VPS restarts mid-batch, the campaign picks up from the rows that aren't yet
marked sent, rather than starting over and double-sending. It is at-least-once,
not exactly-once — I'd rather be honest about that than pretend a distributed send
can be perfectly transactional — but a recorded `sent` row is never sent again on
resume.

## The build process

I built this spec-first and AI-assisted. Each phase started as a written plan —
what it must do, the trust boundaries, the security threats to mitigate — before
any code. The plans became executable checklists: implement, verify against the
plan's own acceptance criteria, commit atomically, summarize. That discipline
kept the security-sensitive parts (the credential encryption, the route
allowlist, the send-confirmation gate) from being afterthoughts. The route-probe
smoke test that ships in this repo, for instance, is a positive regression test:
it asserts the public pages are reachable signed-out _and_ that the authed routes
still redirect to sign-in, so the allowlist can't silently over-expose the app.

## What it is now

The same merge-and-send engine has two front-ends: the web app for signed-in
users, and a standalone CLI and MCP server for scripts and AI agents. It does one
thing — send one reliable, personalized email per row of your CSV, over your own
SMTP, with a preview, a test-send, and a record of what happened — and it tries
to do that one thing carefully.
