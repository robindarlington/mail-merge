---
created: 2026-07-13
title: "WR-08: catch decrypt() failure in blank-password edit merge"
area: smtp-onboarding
source: 02-REVIEW.md (delta re-review after CR-01 fix)
severity: warning
---

`decrypt()` at `lib/smtp/actions-core.ts:110-114` is uncaught. A GCM auth-tag
mismatch (CREDENTIAL_ENC_KEY rotation, restored DB, corrupted blob) throws through
`verifyAndSave` to the wire — violating the module's "never rejects" contract
(`actions-core.ts:40`) and landing the user in WR-02's permanent "Verifying…"
lockup, for exactly the user who needs a "re-enter your password" message.

**Fix:** wrap the decrypt in try/catch; on failure return a validation-kind
ActionResult anchored to the password field: "We couldn't read your saved
password — please re-enter it."
