---
phase: 02-auth-smtp-onboarding
plan: 08
subsystem: smtp-onboarding
tags: [smtp, edit-flow, crypto, validation, security, gap-closure]
requires:
  - lib/smtp/actions-core.ts applyVerifiedConfig (verify-then-save seam)
  - lib/data/smtp.ts getSmtpConfigForUser (userId-scoped lookup)
  - lib/crypto decrypt/encrypt (AES-256-GCM triple)
provides:
  - smtpEditFormSchema — edit-mode schema variant allowing a blank password (keep-on-blank, D-07)
  - applyVerifiedConfig blank-password merge branch (stored-password substitution)
  - wizard resolver switch (edit vs create schema)
affects:
  - lib/smtp/schema.ts
  - lib/smtp/actions-core.ts
  - components/smtp/smtp-wizard.tsx
  - lib/smtp/actions.test.ts
tech-stack:
  added: []
  patterns:
    - "Edit-schema variant via zod .extend() rather than a divergent second schema"
    - "Server-side stored-secret merge before verify/persist (client never re-sends the secret)"
key-files:
  created: []
  modified:
    - lib/smtp/schema.ts
    - lib/smtp/actions-core.ts
    - components/smtp/smtp-wizard.tsx
    - lib/smtp/actions.test.ts
decisions:
  - "Blank password in edit mode = 'keep stored' signal, resolved server-side in applyVerifiedConfig"
  - "Blank password with no stored row re-imposes the create-flow 'password required' rule (validation error, saves nothing)"
metrics:
  tasks: 2
  files-modified: 4
  tests-added: 2
  completed: 2026-07-12
---

# Phase 2 Plan 08: Blank-Password SMTP Edit Merge Summary

Closes CR-01: a returning user can edit their saved SMTP connection (host/port/TLS/username) and leave the password blank — the server re-verifies against and preserves the STORED password instead of dead-ending on "Password is required".

## What Was Built

A complete blank-password-edit vertical slice, delivered TDD (RED → GREEN):

1. **`smtpEditFormSchema`** (`lib/smtp/schema.ts`) — an edit-mode variant of `smtpFormSchema` derived via `.extend({ password: z.string() })` so a blank password is accepted. The base schema comment was corrected to state plainly that the base always requires a password (create flow) and only `smtpEditFormSchema` relaxes it (D-07).

2. **Blank-password merge branch** (`lib/smtp/actions-core.ts` `applyVerifiedConfig`) — now parses with `smtpEditFormSchema`. When the submitted password is `""`, it fetches the caller's own stored row via `getSmtpConfigForUser(userId)` (userId-scoped, no client-supplied id), decrypts the stored triple server-side, and assigns the plaintext onto `parsed.data.password` BEFORE verify/persist. A blank with no stored row returns a `validation` error and saves nothing. The existing verify → encrypt → upsert flow below is untouched.

3. **Wizard resolver switch** (`components/smtp/smtp-wizard.tsx`) — `zodResolver` picks `smtpEditFormSchema` when `isEdit` is true, `smtpFormSchema` otherwise. Create mode still requires a password client-side.

## Task Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 (RED) | Failing tests for blank-password edit merge | `914a780` | lib/smtp/actions.test.ts |
| 2 (GREEN) | Edit schema + server merge + wizard resolver | `987eb9f` | lib/smtp/schema.ts, lib/smtp/actions-core.ts, components/smtp/smtp-wizard.tsx |

## Verification

- `node --import tsx --test lib/smtp/actions.test.ts` — 10 pass, 0 fail (the two new tests plus all 8 prior).
- `npx tsc --noEmit` — exits 0.
- `node --import tsx --test 'lib/**/*.test.ts'` — 87 pass, 0 fail (no regression).
- Reproduction flip confirmed: `smtpFormSchema` still rejects `password:""`; `smtpEditFormSchema` accepts it.
- Redaction audit: the decrypted plaintext is assigned ONLY to `parsed.data.password` (local scope) and flows to `verifyFn`/`encrypt` — it is never placed on an `ActionResult`, thrown, or logged.

## Threat Model Compliance

- **T-2-08-CRED** (Information Disclosure): mitigated — decrypted plaintext stays local; `ActionError` remains the closed message-only union; redaction assertions still hold.
- **T-2-08-IDOR** (Spoofing/EoP): mitigated — lookup is `getSmtpConfigForUser(userId)` with `userId` re-derived by `verifyAndSave` from Clerk `auth()`; no client id trusted.
- **T-2-08-BLANK** (Tampering): mitigated — blank with no stored row rejects and saves nothing; `encrypt` runs only after a real/merged password exists.
- **T-2-08-SC** (supply chain): accepted — no new packages; reuses `zod`, `../crypto`, `../data/smtp`.

## Deviations from Plan

**Test B was already green in the RED phase (expected, not a defect).**
- **Found during:** Task 1 (RED confirmation).
- **Detail:** The plan expected BOTH new tests to fail against the current tree. Test A ("keeps the stored password") failed as the true gap reproduction. Test B ("rejects a blank password when no stored config exists") already passed because the pre-Task-2 base schema rejects *all* blank passwords at parse time — which happens to satisfy Test B's assertion (validation error + nothing saved). Test B is a guard that must continue to hold after Task 2 relaxes the schema (and it does), so it was kept as-is. No code change was needed to make it red; the fail-fast rule was considered and the passing test was confirmed to be a legitimate invariant guard rather than a mis-targeted test.
- **Impact:** None on behavior. Task 1's `<verify>` uses the TAP reporter format (`not ok`), which matches on Test A's failing line, so the automated RED check passes as written.

## Self-Check: PASSED

- Files modified exist: lib/smtp/schema.ts, lib/smtp/actions-core.ts, components/smtp/smtp-wizard.tsx, lib/smtp/actions.test.ts — all present.
- Commits present: `914a780` (test), `987eb9f` (feat) — both in `git log`.
