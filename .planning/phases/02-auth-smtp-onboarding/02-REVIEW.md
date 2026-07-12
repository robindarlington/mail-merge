---
phase: 02-auth-smtp-onboarding
reviewed: 2026-07-13T00:00:00Z
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
  critical: 0
  warning: 9
  info: 11
  total: 20
status: issues_found
---

# Phase 02: Code Review Report (Revision 2 — 02-08 delta re-review)

**Reviewed:** 2026-07-13T00:00:00Z
**Depth:** standard
**Files Reviewed:** 38 (this revision re-reviewed only the 4-file 02-08 delta)
**Status:** issues_found

## Summary

This is a delta re-review following the 02-08 gap-closure plan for CR-01 (blank-password edit flow). The full 38-file phase review ran on 2026-07-11; this revision freshly re-reviewed only the four files 02-08 changed — `lib/smtp/schema.ts`, `lib/smtp/actions-core.ts`, `components/smtp/smtp-wizard.tsx`, `lib/smtp/actions.test.ts` (diff base `dcfbb68`) — plus the surrounding call chain (`lib/smtp/actions.ts`, `lib/crypto/index.ts`, `lib/data/smtp.ts`, `components/smtp/step-verify.tsx`, `components/smtp/step-details.tsx`) read for context. The other 34 files were not re-reviewed; their findings are carried forward verbatim.

**CR-01 is RESOLVED** (see Resolved section below for the verification detail). The fix is correct on its stated security invariants: the merge is userId-scoped, the decrypted plaintext never reaches the client, a log line, or the DB unencrypted, and the blank-without-stored-row case fails safely as a validation error without persisting anything.

However, the delta introduces two new warnings: an uncaught `decrypt()` throw in the merge path that violates the seam's "never rejects" contract and feeds the WR-02 client lockup (WR-08), and a credential-exfiltration escalation — the blank-keep merge now lets a session-holding attacker who does *not* know the SMTP password redirect it, via SMTP AUTH, to a host they control (WR-09). Two new info items cover a dead type export and a discarded server-side validation issue path.

Prior warnings WR-01–WR-07 and info items IN-01–IN-09 were checked against the delta: none were resolved or invalidated by 02-08 (WR-02's missing try/catch in `step-verify.tsx` was re-confirmed during this pass and now also gates WR-08's failure mode). Line references into the two delta-shifted files were updated; finding text is otherwise verbatim.

## Resolved

### CR-01 (RESOLVED by plan 02-08): Edit mode's "leave blank to keep your current password" is now implemented end to end

Original finding: the UI promised "leave blank to keep your current password" in two places, but the schema unconditionally required a password, the wizard used the base resolver in edit mode, and the server had no merge-with-stored-password path — any connection-field edit dead-ended in a contradictory validation error.

Verified resolved in this re-review, against the specific concerns raised:

1. **Schema** — `smtpEditFormSchema` (`lib/smtp/schema.ts:89-91`) relaxes only `password` to `z.string()`; the base create schema keeps `min(1)`.
2. **Client** — `smtp-wizard.tsx:92-94` selects the edit schema only when `isEdit`, so the create flow still requires a password client-side; the password default stays blank and is never prefilled (`:102`).
3. **Server merge is userId-scoped** — `applyVerifiedConfig` (`lib/smtp/actions-core.ts:97-115`) looks up `getSmtpConfigForUser(userId)` where `userId` comes exclusively from Clerk `auth()` in the `verifyAndSave` wrapper (`lib/smtp/actions.ts:68`). No client-supplied id exists anywhere on the path; a caller can only ever merge their own stored credential.
4. **Plaintext containment** — the decrypted password is assigned into the local `parsed.data.password` only; it flows to `verifyFn` and `encrypt()` and appears in no `ActionResult` branch, no log statement, and is re-persisted only as a fresh AES-256-GCM triple (`:134-145`). (But see WR-08 for an uncaught throw on the decrypt itself, and WR-09 for where the plaintext is *sent*.)
5. **Blank + no stored row fails safely** — returns `{ kind: "validation" }` with a `path: ["password"]` issue and persists nothing (`:99-109`), re-imposing the create-flow rule.
6. **Tests prove the seam** — `actions.test.ts:190-255` proves the stored password is substituted *before* verify (captured verifyFn input equals the marker), the persisted row still round-trips to the original password after a host change, the no-row blank case rejects without persisting, and no result JSON contains the marker.

Confirmed by human UAT against a live SMTP server per the 02-08 plan record.

## Critical Issues

None open. (CR-01 resolved above.)

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
**Issue:** All three client call sites assume the Server Action promise always resolves: `onPendingChange(true); const res = await verifyAndSave(values); onPendingChange(false);` (and the same shape in `runFromOnly` and `send()`). Server Action invocations reject on network failure, a mid-deploy stale action id, or a thrown server error (e.g. `decrypt()` throwing on a bad `CREDENTIAL_ENC_KEY` in `sendTestEmail` — that throw is not caught server-side and surfaces as a client-side rejection). When that happens, the line resetting `pending`/`sending` never runs: the button stays disabled with a perpetual "Verifying…"/"Sending…" spinner, step 1's whole fieldset stays disabled (it's bound to `pending`), and no error is shown. The only escape is a full page reload. *(Re-confirmed unresolved in this delta pass; the new WR-08 decrypt path in `applyVerifiedConfig` adds another server-side throw that lands here.)*
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

**File:** `lib/smtp/actions.ts:109-135`, `lib/smtp/actions-core.ts:156-196`
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

### WR-08: Uncaught `decrypt()` throw in the blank-password merge violates the seam's "never rejects" contract and triggers the WR-02 client lockup

**File:** `lib/smtp/actions-core.ts:110-114` (new in 02-08)
**Issue:** The blank-password merge calls `decrypt()` on the stored triple with no try/catch. `decrypt` throws on a GCM auth-tag mismatch (`lib/crypto/index.ts:74`) — which happens whenever `CREDENTIAL_ENC_KEY` has changed since the row was stored (rotation, misconfigured deploy, restored DB with the wrong key) or the blob is corrupted. The throw propagates through `applyVerifiedConfig` and `verifyAndSave` (no catch anywhere on the path, `lib/smtp/actions.ts:63-74`) to the wire as a Server Action rejection. This directly contradicts the module's own contract — "The uniform result every Server Action here resolves to (never rejects)" (`actions-core.ts:40`) — and, because the client's `runVerify` has no try/catch (WR-02), the user who hits it gets a permanently disabled form with a perpetual "Verifying…" spinner and no error message. The exact user in this scenario (stored credential undecryptable) is the one who most needs the actionable "re-enter your password" signal. `sendTestEmail` has the same latent decrypt throw (noted under WR-02), but 02-08 added a second, more likely-to-be-hit instance: an edit-with-blank submit is the natural first action after any key rotation.
**Fix:** Catch and convert to the existing validation shape so the user is told to re-enter the credential:

```ts
try {
  parsed.data.password = decrypt({
    enc: existing.password_enc as Buffer,
    iv: existing.password_iv as Buffer,
    tag: existing.password_tag as Buffer,
  });
} catch {
  return {
    ok: false,
    error: {
      kind: "validation",
      issues: [{ code: "custom", path: ["password"],
                 message: "Your saved password can't be read — enter it again." }],
    },
  };
}
```

Add a seam test that stores a row, swaps `CREDENTIAL_ENC_KEY`, and asserts the blank-edit resolves (not rejects) with a validation error.

### WR-09: Blank-password keep combined with a changed host lets a session-holding attacker exfiltrate the stored SMTP password

**File:** `lib/smtp/actions-core.ts:97-117` (new in 02-08), `lib/smtp/schema.ts:89-91`
**Issue:** The merge substitutes the stored plaintext password and then dials whatever `host:port` the *submitted* form specifies (`verifyFn(parsed.data)` → real SMTP AUTH). Before 02-08, changing the host required re-typing the password — an attacker holding a hijacked session but not the credential could not point the config anywhere useful. After 02-08, that attacker can submit an edit with `host` set to a server they control, `password` blank, and valid-looking other fields; the server decrypts the victim's stored SMTP password and performs SMTP AUTH (PLAIN/LOGIN — the password, base64-encoded, on the wire) against the attacker's host, which simply accepts the AUTH and records it. Verify even "succeeds," persisting the hijacked config. This escalates a transient session compromise into persistent plaintext SMTP-credential capture — credentials that outlive session revocation and are frequently reused. The precondition (an authenticated session) is real but is exactly the boundary the D-07 "never re-send the secret to the client" design exists to defend; the merge quietly re-sends it to an arbitrary *server* instead.
**Fix:** Require an explicit password whenever the connection identity changes — only allow the blank-keep merge when the submitted `host` (and ideally `port`/`username`) matches the stored row:

```ts
if (parsed.data.password === "") {
  const existing = await getSmtpConfigForUser(userId);
  if (!existing || existing.host !== parsed.data.host || existing.username !== parsed.data.username) {
    return { ok: false, error: { kind: "validation", issues: [{
      code: "custom", path: ["password"],
      message: "Enter your password to change the server or username.",
    }]}};
  }
  // ...decrypt + merge
}
```

Mirror the constraint in the edit UI copy. If instead the team decides same-account host migration with a kept password is a supported flow, record that risk acceptance explicitly in the plan — it is currently unstated. Note the seam test at `actions.test.ts:190-241` deliberately exercises a *changed host* with a kept password, so the current behavior is load-bearing in tests; the test would need updating alongside the fix.

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

**File:** `components/smtp/smtp-wizard.tsx:104`, `lib/smtp/actions-core.ts:144`, `lib/smtp/actions.ts:97` *(line refs updated for the 02-08 diff; finding unchanged)*
**Issue:** The wizard defaults `from_name` to `""`; `z.string().trim().optional()` passes `""` through; `parsed.data.from_name ?? null` only maps `undefined` to null, so a blank name is stored as an empty string. All current consumers use truthiness so display is unaffected, but the column's null semantics are inconsistent (some rows `NULL`, some `""`).
**Fix:** Normalize in the schema: `from_name: z.string().trim().optional().transform((v) => (v ? v : undefined))` or map `parsed.data.from_name || null` at the persistence sites.

### IN-04: Verify rate limiter grows without bound and charges budget for validation failures

**File:** `lib/smtp/actions-core.ts:47-67`, `lib/smtp/actions.ts:70-73`
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

### IN-10: `SmtpEditFormValues` is exported but never used anywhere

**File:** `lib/smtp/schema.ts:93` (new in 02-08)
**Issue:** The `SmtpEditFormValues` type alias is exported but has zero importers (grep-confirmed across `lib/`, `components/`, `app/`). The wizard drives its `useForm` with `SmtpFormValues` even in edit mode (the shapes are structurally identical, so this works), and `applyVerifiedConfig` types its `verifyFn` parameter with `SmtpFormValues` too. Dead export.
**Fix:** Either delete the export, or use it where edit-mode values are actually in play (e.g. the wizard's resolver cast) so the type earns its keep.

### IN-11: Server-side validation issues are discarded by the client — the new blank-no-row error shows "Check the highlighted fields" with nothing highlighted

**File:** `lib/smtp/actions-core.ts:99-109` (new in 02-08), `components/smtp/step-verify.tsx:93-97`
**Issue:** The blank-without-stored-row branch carefully constructs a zod-shaped issue with `path: ["password"]` and message "Password is required", but `applyError`'s `validation` branch never maps `issues` onto form controls — it shows the generic "Some details are invalid. Check the highlighted fields." while highlighting nothing. Unreachable through the normal UI (edit mode implies a stored row exists), but reachable by wire callers and by any future server-only validation divergence; the copy is actively misleading when it fires. Pre-existing for all server-side validation failures; 02-08 added the first hand-built issue that the client then throws away.
**Fix:** In `applyError`'s validation case, walk `error.issues` and `form.setError(issue.path[0], { message: issue.message })` for paths that match form fields, falling back to the generic alert otherwise.

---

_Reviewed: 2026-07-13T00:00:00Z (revision 2 — 02-08 delta re-review; original full review 2026-07-11T10:30:00Z)_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
