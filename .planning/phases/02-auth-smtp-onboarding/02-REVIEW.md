---
phase: 02-auth-smtp-onboarding
reviewed: 2026-07-11T10:30:00Z
depth: standard
files_reviewed: 38
files_reviewed_list:
  - app/(app)/dashboard/page.tsx
  - app/(app)/layout.tsx
  - app/(app)/settings/smtp/page.tsx
  - app/globals.css
  - app/layout.tsx
  - app/page.tsx
  - app/sign-in/[[...sign-in]]/page.tsx
  - app/sign-up/[[...sign-up]]/page.tsx
  - components/app-sidebar.tsx
  - components/site-footer.tsx
  - components/smtp/smtp-wizard.tsx
  - components/smtp/step-details.tsx
  - components/smtp/step-test-send.tsx
  - components/smtp/step-verify.tsx
  - drizzle/0001_shiny_stature.sql
  - drizzle/meta/_journal.json
  - drizzle/meta/0001_snapshot.json
  - hooks/use-mobile.ts
  - lib/config.ts
  - lib/core/send.ts
  - lib/data/dto.test.ts
  - lib/data/index.ts
  - lib/data/smtp.test.ts
  - lib/data/smtp.ts
  - lib/db/schema.ts
  - lib/smtp/actions-core.ts
  - lib/smtp/actions.test.ts
  - lib/smtp/actions.ts
  - lib/smtp/errors.test.ts
  - lib/smtp/errors.ts
  - lib/smtp/index.ts
  - lib/smtp/schema.test.ts
  - lib/smtp/schema.ts
  - lib/smtp/verify.test.ts
  - lib/smtp/verify.ts
  - proxy.ts
  - Dockerfile
  - docker-compose.yml
findings:
  critical: 1
  warning: 7
  info: 9
  total: 17
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-07-11T10:30:00Z
**Depth:** standard
**Files Reviewed:** 38
**Status:** issues_found

## Summary

Reviewed the Phase 02 auth + SMTP onboarding surface: Clerk middleware (proxy.ts), the userId-scoped DAL and DTO redaction boundary, the verify engine and error classifier, the three "use server" actions plus their testable seams, the three-step wizard UI, and the Docker/Coolify deploy artifacts.

The headline security invariants hold up well under scrutiny: the encrypted password triple never crosses the server→client boundary (DTO is enumerated, not filtered, and tests prove it with a marker password); every DAL path is userId-scoped; only the three auth-guarded actions are runtime exports of the `"use server"` module; `transport.verify()` runs before every send; no `rejectUnauthorized: false` exists in lib code; and `CLERK_SECRET_KEY` / `CREDENTIAL_ENC_KEY` are runtime-only in compose while only `NEXT_PUBLIC_*` values are build ARGs.

However, the review found one blocker: the edit flow's advertised "leave blank to keep your current password" behavior (D-07) is promised by the UI in two places but implemented nowhere — the shared schema unconditionally requires a password and the server has no merge-with-stored-password path, so any connection-field edit dead-ends in a contradictory validation error. Several warnings follow: a substring-based error classifier that misfires on real-world hostnames containing "ssl"/"tls", client pending-state lockups when a Server Action rejects at the network layer, unvalidated recipient input on `sendTestEmail`, SSRF-literal bypasses, a compose image-tag collision that can strip the Clerk publishable key from the web bundle, and a CSS cascade conflict that defeats both the loaded Geist font and the dark-mode tokens.

## Critical Issues

### CR-01: Edit mode's "leave blank to keep your current password" is promised by the UI but not implemented anywhere

**File:** `lib/smtp/schema.ts:72-74`, `components/smtp/step-details.tsx:156-163`, `lib/smtp/actions-core.ts:83-116`, `components/smtp/smtp-wizard.tsx:29`
**Issue:** The password field's UI copy in edit mode explicitly promises "Leave blank to keep your current password" (both as the input placeholder and as a `FormDescription`), and the schema comment at `lib/smtp/schema.ts:72-73` claims "Edit flow makes this optional ('leave blank to keep', D-07)". Nothing implements this:

1. `smtpFormSchema.password` is `z.string().min(1, "Password is required")` unconditionally — there is no edit-mode variant.
2. The wizard uses `zodResolver(smtpFormSchema)` regardless of `isEdit`, so a blank password fails client validation.
3. `applyVerifiedConfig` parses with the same schema server-side and unconditionally encrypts `parsed.data.password` — there is no "fetch the stored password when blank" merge path, so even relaxing the schema alone would verify with (and persist) an empty password, destroying the stored credential.

Concrete broken flow: a user in edit mode changes only the port (or host, secure, or username). `connectionDirty` is true, so the primary action is "Verify & continue" → `form.handleSubmit` → zod fails on the blank password → the field shows "Password is required" directly beneath the placeholder that says "Leave blank to keep your current password". The user cannot proceed without re-typing a password the UI told them they could omit. The advertised D-07 contract is broken and the UX is self-contradictory.

**Fix:** Implement the keep-on-blank path end to end:

```ts
// lib/smtp/schema.ts — add an edit variant
export const smtpEditFormSchema = smtpFormSchema.extend({
  password: z.string(), // blank allowed in edit mode = keep stored
});
```

```ts
// lib/smtp/actions.ts — verifyAndSave: when the caller has a stored config and
// the submitted password is blank, decrypt and substitute the stored password
// BEFORE verify/persist (server-side only; never returned):
if (parsed.data.password === "") {
  const row = await getSmtpConfigForUser(userId);
  if (!row) return { ok: false, error: { kind: "validation", issues: [...] } };
  parsed.data.password = decrypt({ enc: row.password_enc, iv: row.password_iv, tag: row.password_tag });
}
```

And switch the wizard's resolver to the edit schema when `isEdit` is true. Alternatively, if keep-on-blank is intentionally out of scope, remove the placeholder, the `FormDescription`, and the stale schema comment so the UI stops promising it — but the D-07 references throughout the codebase indicate the behavior is required.

## Warnings

### WR-01: `classifyVerifyError` substring match misclassifies real hostnames containing "ssl"/"tls" as TLS-mode failures

**File:** `lib/smtp/errors.ts:40-42`
**Issue:** The TLS branch tests `/wrong version number|ssl|tls|handshake/i` against the error message **before** the code-based `EDNS`/`ECONNECTION`/`ETIMEDOUT`/`ESOCKET` reachability checks. Nodemailer connection errors embed the hostname in the message (e.g. `getaddrinfo ENOTFOUND ssl0.ovh.net`, `connect ECONNREFUSED smtp-tls.example.com:587`). `ssl0.ovh.net` is OVH's real production SMTP host — a user who typos its port gets classified `{ kind: "tls", field: "tlsMode" }` instead of `connection/hostPort`, anchoring the error to the wrong control, and `verifySmtp` (verify.ts:99-110) then burns a second full-timeout dial on the pointless alternate-mode probe. The test suite never covers a message whose hostname contains "ssl"/"tls", so this passes CI.
**Fix:** Check unambiguous error codes first and tighten the message patterns:

```ts
if (err.code === "EAUTH") return { kind: "auth", field: "auth" };
if (err.code === "EDNS" || err.code === "ECONNECTION")
  return { kind: "connection", field: "hostPort" };
if (/wrong version number|ssl3_|handshake failure|:SSL routines:/i.test(msg))
  return { kind: "tls", field: "tlsMode" };
// ... then ETIMEDOUT/greeting, then generic ESOCKET/ETIMEDOUT → connection
```

Add classifier test fixtures whose messages contain "ssl"/"tls" hostnames.

### WR-02: A rejected Server Action call permanently locks the wizard in its pending/sending state

**File:** `components/smtp/step-verify.tsx:124-137,140-155`, `components/smtp/step-test-send.tsx:66-78`
**Issue:** All three client call sites assume the Server Action promise always resolves: `onPendingChange(true); const res = await verifyAndSave(values); onPendingChange(false);` (and the same shape in `runFromOnly` and `send()`). Server Action invocations reject on network failure, a mid-deploy stale action id, or a thrown server error (e.g. `decrypt()` throwing on a bad `CREDENTIAL_ENC_KEY` in `sendTestEmail` — that throw is not caught server-side and surfaces as a client-side rejection). When that happens, the line resetting `pending`/`sending` never runs: the button stays disabled with a perpetual "Verifying…"/"Sending…" spinner, step 1's whole fieldset stays disabled (it's bound to `pending`), and no error is shown. The only escape is a full page reload.
**Fix:** Wrap each call in try/catch/finally:

```ts
onPendingChange(true);
try {
  const res = await verifyAndSave(values);
  if (res.ok) { onVerified(); return; }
  applyError(res.error);
} catch {
  setDetail({ message: "Something went wrong talking to the server. Try again." });
} finally {
  onPendingChange(false);
}
```

Apply the same pattern in `runFromOnly` and `StepTestSend.send`.

### WR-03: `sendTestEmail` accepts a completely unvalidated client-supplied recipient string

**File:** `lib/smtp/actions.ts:109-135`, `lib/smtp/actions-core.ts:153-158`
**Issue:** `sendTestEmail(toAddress?: string)` is a client-invocable endpoint, and `toAddress` flows into nodemailer's `to` field with no validation whatsoever — no `z.email()` parse, no length cap. Nodemailer interprets a comma-separated string as **multiple recipients**, so a single call with `"a@x.com, b@x.com, c@x.com, ..."` fans out one call into arbitrarily many deliveries. The client UI's `type="email"` input is not a control (the action is directly wire-callable), and notably the wizard's own `failureFor` maps a `validation` error kind to "the recipient address is invalid" (`step-test-send.tsx:39`) — a branch the server can never produce for this action, confirming the intended validation was never written. Impact is bounded (the mail goes through the caller's own SMTP with a fixed subject/body), but this is a missing input validation at a trust boundary and breaks the "one test email to one address" contract.
**Fix:** Validate before use:

```ts
const toParsed = z.email().max(254).safeParse(to);
if (!toParsed.success) {
  return { ok: false, error: { kind: "validation", issues: toParsed.error.issues } };
}
```

### WR-04: `sendTestEmail` has no rate limit — verify is budgeted, real sends are not

**File:** `lib/smtp/actions.ts:109-161`, `lib/smtp/actions-core.ts:47-67`
**Issue:** `verifyAndSave` enforces `underVerifyRateLimit` (5 attempts/60s) because "a user-supplied host:port dial is an abuse/SSRF surface" — but `sendTestEmail` performs the exact same dial (`verifyTransport`) **plus a real delivery** with zero throttling. An authenticated user (or a script holding their session) can invoke it in an unbounded loop, hammering the saved host and, combined with WR-03, delivering unlimited messages to arbitrary recipients. The T-2-SPAM rationale that justified the verify limiter applies at least as strongly here.
**Fix:** Reuse the same in-process limiter (or a sibling with its own bucket) at the top of `sendTestEmail`:

```ts
if (!underVerifyRateLimit(`test-send:${userId}`)) {
  return { ok: false, error: { kind: "rate_limited" } };
}
```

(`failureFor` in step-test-send.tsx already handles `rate_limited`.)

### WR-05: `isPrivateHostLiteral` misses several literal loopback/private encodings within its stated scope

**File:** `lib/smtp/schema.ts:30-55`
**Issue:** The function's documented v1 scope is "literal IPs / localhost are screened". Several **literals** that Node's `getaddrinfo` happily resolves to loopback/private addresses pass the check:
- Expanded IPv6 loopback `0:0:0:0:0:0:0:1` — only the compressed `::1` spelling is matched (line 36).
- Short-form IPv4 `127.1`, `10.1` — the dotted-quad regex (line 44) requires four octets; glibc `inet_aton` semantics resolve `127.1` → `127.0.0.1`.
- Decimal/hex/octal single-number forms `2130706433`, `0x7f000001`, `017700000001` → `127.0.0.1` on common libc resolvers.
- Hex-grouped mapped IPv6 `::ffff:7f00:1` — only the dotted-decimal mapped form `::ffff:127.0.0.1` is matched (line 41).

Each bypass lets `verifySmtp` dial the VPS's own loopback/LAN with attacker-chosen ports and read the classified error (`connection` vs `tls` vs `auth`) as a port-scan oracle — precisely what the check exists to prevent. DNS-resolving hostnames are legitimately out of scope (assumption A5); these are not, because they are literals.
**Fix:** Normalize before checking: parse with `net.isIP` / `ipaddr.js`-style logic (or reject any all-numeric / `0x`-prefixed host outright, and expand IPv6 with `new URL()`-independent parsing), then compare the parsed address against the ranges. At minimum: reject hosts matching `/^\d+$/` and `/^0x[0-9a-f]+$/i`, canonicalize IPv6 via `net.isIPv6` + expansion, and handle `::ffff:` hex-grouped forms.

### WR-06: compose builds two images under the same tag — the worker build (no Clerk ARGs) can silently replace the web image

**File:** `docker-compose.yml:17-69`
**Issue:** Both `web` and `worker` declare a `build:` block **and** the same `image: mail-merge:skeleton` tag, but only `web` passes the `NEXT_PUBLIC_CLERK_*` build args. Compose builds each service's image independently and tags both `mail-merge:skeleton`; whichever build finishes last owns the tag. If the worker's build wins, the web container can end up running a bundle built **without** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` inlined — Clerk fails at runtime with a missing-publishable-key error, nondeterministically depending on build order and cache state. This directly undermines the Dockerfile's own Pitfall-3 comment about the ARGs needing to be present at build time.
**Fix:** Build once, reuse for the worker:

```yaml
worker:
  image: mail-merge:skeleton   # no build: block — reuse web's image
  depends_on:
    - web
```

(The NEXT_PUBLIC values are client-safe, so the shared image is fine; alternatively give the worker its own tag.)

### WR-07: Unlayered `body` rule in globals.css defeats both the loaded Geist font and the dark-mode tokens

**File:** `app/globals.css:9-12,54-59,140-149`
**Issue:** The unlayered `body { background: var(--color-background); color: var(--color-foreground); font-family: ui-sans-serif, ... }` block (lines 54-59) wins the cascade over everything inside `@layer base` (unlayered declarations beat layered ones). Consequences:
1. `app/layout.tsx` loads Geist via `next/font` and sets `--font-sans` on `<html>`, and `@layer base html { @apply font-sans }` applies it — but the unlayered body rule's hardcoded `ui-sans-serif` stack overrides the inheritance, so **Geist is downloaded but never rendered** for body content.
2. The first `@theme` block emits static `--color-background: #ffffff` / `--color-foreground: #0a0a0a`, so the body background/text are pinned to light values regardless of the `.dark` token set (lines 105-138); the layered `@apply bg-background text-foreground` that would track `.dark` is overridden.
3. `:root { color-scheme: light dark }` (line 15) tells the UA it may render dark-styled form controls and scrollbars for dark-preference users — on a page whose body is hard-pinned white, producing mismatched dark inputs on a light page today, with no theme toggle to correct it.
**Fix:** Delete the unlayered `body` block entirely (the `@layer base` rules at 140-149 already cover background/text/font), and either drop `color-scheme: light dark` until a theme toggle ships or scope it: `:root { color-scheme: light; } .dark { color-scheme: dark; }`. Remove the now-redundant static `--color-background/--color-foreground` pair from the first `@theme` block.

## Info

### IN-01: Dashboard's "Re-verify required" state (state 3) is unreachable dead code

**File:** `app/(app)/dashboard/page.tsx:25-26,62,84-85`
**Issue:** The card branches on `config.verified_at !== null`, but no code path ever produces a row with `verified_at = null`: `upsertSmtpConfig` stamps it on every insert **and** update, `updateFromFields` doesn't touch it, and connection edits can only persist via a successful verify. The documented trigger ("verified_at cleared by an edit") is not implemented.
**Fix:** Either implement clearing `verified_at` when a connection edit is abandoned mid-wizard (if that's the intended semantics), or note in the comment that state 3 is forward-provisioned and currently unreachable.

### IN-02: Test-send success toast renders "check 's inbox" when the recipient field was cleared

**File:** `components/smtp/step-test-send.tsx:70-73`
**Issue:** `sendTestEmail(recipient || undefined)` lets the server fall back to the Clerk primary email when the field is blank, but the toast interpolates the client-side `recipient` — an empty string — producing "Test email sent — check 's inbox."
**Fix:** `toast.success(recipient ? \`Test email sent — check ${recipient}'s inbox.\` : "Test email sent — check your inbox.")`

### IN-03: Empty `from_name` is persisted as `""` instead of `NULL`

**File:** `components/smtp/smtp-wizard.tsx:96`, `lib/smtp/actions-core.ts:115`, `lib/smtp/actions.ts:97`
**Issue:** The wizard defaults `from_name` to `""`; `z.string().trim().optional()` passes `""` through; `parsed.data.from_name ?? null` only maps `undefined` to null, so a blank name is stored as an empty string. All current consumers use truthiness so display is unaffected, but the column's null semantics are inconsistent (some rows `NULL`, some `""`).
**Fix:** Normalize in the schema: `from_name: z.string().trim().optional().transform((v) => (v ? v : undefined))` or map `parsed.data.from_name || null` at the persistence sites.

### IN-04: Verify rate limiter grows without bound and charges budget for validation failures

**File:** `lib/smtp/actions-core.ts:49-67`, `lib/smtp/actions.ts:70-73`
**Issue:** (a) `verifyAttempts` keeps one entry per userId forever — stale users' arrays are pruned only if that same user calls again, so the Map grows monotonically for the process lifetime. (b) `verifyAndSave` checks the limiter *before* parsing, so a request that fails zod validation (no dial ever happens) still consumes one of the five per-minute attempts.
**Fix:** Sweep empty/stale entries during `underVerifyRateLimit` (delete keys whose filtered array is empty), and move the rate-limit check after `safeParse` (or refund on validation failure) so only actual dials are budgeted.

### IN-05: proxy.ts matcher exempts `.csv`/`.docx`/`.xlsx`/`.zip` URLs from auth middleware

**File:** `proxy.ts:34`
**Issue:** The static-asset skip list deliberately includes user-data extensions ("incl. .csv uploads" per the comment). Any future route whose path ends in `.csv` (e.g. a recipient-set download endpoint not under `/api`) will bypass Clerk middleware entirely and must implement its own auth. This is a latent footgun for the Phase 3+ CSV features, not a current vulnerability.
**Fix:** When CSV download routes are added, serve them under `/api/...` (always matched) or remove `csv|docx?|xlsx?|zip` from the skip list, and record the constraint where the upload feature will be planned.

### IN-06: Stale "grep-asserted below" claim in verify.test.ts — no such assertion exists

**File:** `lib/smtp/verify.test.ts:10-11`
**Issue:** The header comment says the absence of `rejectUnauthorized: false` in lib code is "grep-asserted below", but the file contains no such assertion. (Manual grep during this review confirms lib code is clean — only the test process env flag exists — but the claimed guard is missing.)
**Fix:** Add the promised assertion (read `lib/smtp/verify.ts` + `lib/core/send.ts` sources and assert `!/rejectUnauthorized/.test(src)`), or delete the claim from the comment.

### IN-07: No `test` script in package.json — the node:test suites have no wired entry point

**File:** `package.json` (scripts block)
**Issue:** Six `*.test.ts` suites exist across lib/, all written for `node:test`, but there is no `npm test` (or equivalent) script, so nothing in the repo documents or automates running them; they will silently rot without a CI hook.
**Fix:** Add `"test": "node --test --import tsx 'lib/**/*.test.ts'"` (or the tsx-runner invocation the suites were verified with).

### IN-08: `updateFromFields` action returns `ok: true` even when no config row exists

**File:** `lib/smtp/actions.ts:82-100`, `lib/data/smtp.ts:106-114`
**Issue:** The DAL update matches zero rows for a user with no config, and the action reports success anyway. Unreachable via the wizard UI (edit mode requires an existing row) but the action is wire-callable, and a silent no-op success masks a client/server state mismatch.
**Fix:** Check `result.changes` (better-sqlite3 run result) or fetch-first, returning a `validation`/`unknown` error when no row was updated.

### IN-09: Signed-out fallthrough renders page content instead of redirecting (defense-in-depth)

**File:** `app/(app)/dashboard/page.tsx:34-35`, `app/(app)/settings/smtp/page.tsx:19-20`
**Issue:** Both RSCs handle `userId == null` by rendering the empty/no-config UI rather than redirecting. Protection currently rests entirely on proxy.ts; if the matcher ever regresses (see IN-05's extension list, or the Next 16 proxy.ts rename pitfall the file itself documents), these pages render for anonymous visitors instead of bouncing them.
**Fix:** Fail closed in the pages: `const { userId } = await auth(); if (!userId) redirect("/sign-in");` — one line each, and the `userId ? ... : undefined` ternaries disappear.

---

_Reviewed: 2026-07-11T10:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
