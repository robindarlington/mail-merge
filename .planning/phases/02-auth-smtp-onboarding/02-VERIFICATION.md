---
phase: 02-auth-smtp-onboarding
verified: 2026-07-12T22:16:43Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "6/7 must-haves verified"
  gaps_closed:
    - "Editing a saved SMTP config re-routes connection-field changes through verify while leaving the password blank (D-07/D-08) — CR-01"
  gaps_remaining: []
  regressions: []
---

# Phase 2: Auth + SMTP Onboarding — Verification Report (Re-verification)

**Phase Goal:** As a signed-in user, I want to onboard and persist my own SMTP server proven functional by a live connection check, so that my credentials are stored encrypted at rest, reused across sessions, and never exposed to the client or logs.

**Verified:** 2026-07-12
**Status:** passed
**Re-verification:** Yes — after gap closure (plans 02-08 gap_closure + 02-09 human-verify checkpoint)

## Re-verification Summary

The prior verification (2026-07-11) found `gaps_found` with exactly one gap: CR-01, the SMTP settings edit flow promised "Leave blank to keep your current password" but `smtpFormSchema.password` unconditionally required a non-blank value and `applyVerifiedConfig` had no stored-password merge path, so any connection-field edit dead-ended on a validation error. A `human_verification` item asked for a live wizard walkthrough to confirm the fix once applied.

Since then:
- **Plan 02-08** (gap_closure, TDD RED→GREEN) added `smtpEditFormSchema` (edit-mode schema variant allowing a blank password), a server-side stored-password merge branch in `applyVerifiedConfig` (fetch + decrypt the caller's own stored row when the submitted password is blank), and switched the wizard's `zodResolver` to the edit schema in edit mode. Commits `914a780` (RED) and `987eb9f` (GREEN), both present in `git log`.
- **Plan 02-09** (human-verify checkpoint) was approved by the user (resume-signal "approved", 2026-07-12) after a live wizard walkthrough on local dev against a real SMTP server, confirming both the positive case (blank-password connection-field edit re-verifies and saves) and the negative case (a wrong typed password still fails with an auth-anchored error).
- **02-REVIEW.md** was delta-re-reviewed against the 4-file 02-08 diff: CR-01 is marked RESOLVED, 0 critical findings remain (9 warnings, 11 info — two new warnings, WR-08/WR-09, introduced by the 02-08 delta, discussed below as non-blocking).

This re-verification independently re-derived every claim below from the codebase, git history, and live test runs — not from SUMMARY.md text.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Sign up/sign in via Clerk; unauthenticated app-route requests redirect to sign-in | ✓ VERIFIED (regression check) | `proxy.ts` unchanged: `clerkMiddleware` + `auth.protect()`; live re-check: `curl -sI https://mailmerge.robindarlington.com/dashboard` and `/settings/smtp` both `307` → `/sign-in` (re-run today) |
| 2 | Every data access scoped to signed-in `userId` | ✓ VERIFIED (regression check) | `lib/data/smtp.ts` unchanged; DTO redaction fields (`password_enc/_iv/_tag`) still structurally excluded; full lib suite re-run (87/87 pass) |
| 3 | User enters SMTP details; onboarding completes only after live `transport.verify()`; errors distinguish auth vs host/port vs TLS | ✓ VERIFIED (regression check) | `lib/smtp/schema.ts`, `lib/smtp/verify.ts`, `lib/smtp/errors.ts` unchanged outside the edit-schema addition; 3 live `smtp-server` fixture tests still pass |
| 4 | Credentials AES-256-GCM-encrypted at rest, reused across sessions, password never in client response or log | ✓ VERIFIED (gap closed) | `lib/crypto/index.ts` unchanged; `applyVerifiedConfig` now has the blank-password merge (`lib/smtp/actions-core.ts:97-115`) that decrypts server-side and substitutes BEFORE verify/persist; decrypted plaintext confirmed to reach only `parsed.data.password` (local var), never an `ActionResult`, throw, or log; redaction test `no failure result ever leaks a config object or a secret` still passes |
| 5 | Final onboarding step offers a test-send to the user's own address | ✓ VERIFIED (regression check) | `components/smtp/step-test-send.tsx`, `lib/smtp/actions.ts sendTestEmail` unchanged; 3/3 relevant tests pass |
| 6 | Phase slice deployed to the standing Coolify staging URL and works there | ✓ VERIFIED (regression check) | Live re-check today: `curl -sI https://mailmerge.robindarlington.com/dashboard` and `/settings/smtp` → `307` to `/sign-in` (auth gating intact, no regression) |
| 7 | Editing a saved SMTP config re-routes connection-field changes through verify while leaving the password blank (D-07/D-08) — the CR-01 gap | ✓ VERIFIED (gap closed) | See "Gap Closure Verification" below — independently re-derived, not trusted from SUMMARY |

**Score:** 7/7 truths verified.

### Gap Closure Verification (Truth #7 — CR-01)

**Method:** Read the actual diff (not the SUMMARY narrative), ran the tests myself, ran an independent reproduction script, and checked the code-review's delta re-review.

1. **Schema** — `lib/smtp/schema.ts:89-93` defines `smtpEditFormSchema = smtpFormSchema.extend({ password: z.string() })`, exported alongside `SmtpEditFormValues`. The base `smtpFormSchema.password` still requires `min(1, "Password is required")` (line 75) — confirmed unconditional for create.
2. **Server merge** — `lib/smtp/actions-core.ts:78-147` `applyVerifiedConfig` now parses with `smtpEditFormSchema` (line 86). Lines 97-115: if `parsed.data.password === ""`, it calls `getSmtpConfigForUser(userId)` (userId-scoped, imported from `../data/smtp`); if no row exists, returns a validation error and persists nothing; otherwise calls `decrypt({ enc, iv, tag })` from `../crypto` and assigns the plaintext onto `parsed.data.password`, which then flows into the existing `verifyFn` → `encrypt` → `upsertSmtpConfig` pipeline untouched.
3. **Wizard resolver** — `components/smtp/smtp-wizard.tsx:92-94`: `zodResolver(isEdit ? smtpEditFormSchema : smtpFormSchema)`. Create mode keeps the base (password-required) schema; edit mode uses the relaxed one.
4. **Independent reproduction** (not copy-pasted from the SUMMARY): ran `smtpFormSchema.safeParse({...password:""})` → `success: false`; ran `smtpEditFormSchema.safeParse({...password:""})` → `success: true`. Confirms the exact flip the plan claimed.
5. **Test suite, run directly by this verifier** (not trusted from SUMMARY text): `node --import tsx --test lib/smtp/actions.test.ts` → `10 pass, 0 fail`, including `applyVerifiedConfig keeps the stored password on a blank-password edit` and `applyVerifiedConfig rejects a blank password when no stored config exists`. Full lib suite: `node --import tsx --test 'lib/**/*.test.ts'` → `87 pass, 0 fail`. `npx tsc --noEmit` → exit 0.
6. **Commits verified in git log:** `914a780` (test, RED) and `987eb9f` (feat, GREEN) both present with diffs matching the plan's described changes (`git show --stat` confirmed file lists and line counts).
7. **Human UAT:** `02-09-SUMMARY.md` records the user's own resume-signal "approved" (2026-07-12) after a live walkthrough against a real SMTP server on local dev, confirming both the positive (blank-password edit saves) and negative (wrong typed password fails) cases. This satisfies the specific `human_verification` item the prior VERIFICATION.md required before closing this gap.
8. **Code review delta re-review** (`02-REVIEW.md`, revision 2, `2026-07-13`) independently confirms CR-01 resolved against the same five concerns (schema, client gating, userId-scoped lookup, plaintext containment, safe-blank-with-no-row rejection) and cites the same test names.

**Status: VERIFIED.** The gap is closed — a connection-field edit with a blank password now merges the stored password server-side, verifies, and saves; it no longer dead-ends on "Password is required."

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/smtp/schema.ts` | `smtpEditFormSchema` edit-mode variant + corrected base-schema comment | ✓ VERIFIED | Exists, exported with `SmtpEditFormValues` type; base schema comment (lines 72-74) now accurately states the base always requires a password and the relaxation lives only in the edit variant |
| `lib/smtp/actions-core.ts` | `applyVerifiedConfig` blank-password merge branch | ✓ VERIFIED | Parses with `smtpEditFormSchema`; merge branch at lines 97-115 calls `getSmtpConfigForUser` + `decrypt`; plaintext never escapes local scope (grep-confirmed: only assignment target is `parsed.data.password`) |
| `components/smtp/smtp-wizard.tsx` | Resolver switches to `smtpEditFormSchema` when `isEdit` | ✓ VERIFIED | Line 92-94 ternary confirmed |
| `lib/smtp/actions.test.ts` | New tests for blank-password merge + no-stored-config rejection | ✓ VERIFIED | `applyVerifiedConfig keeps the stored password on a blank-password edit` and `applyVerifiedConfig rejects a blank password when no stored config exists` both present and passing |

All 6 ROADMAP-level artifacts previously verified (`proxy.ts`, `app/layout.tsx`, sign-in/up pages, `lib/config.ts`, `lib/data/smtp.ts`, migration, `app/(app)` shell, Dockerfile/compose) show no regressions — spot-checked via grep and the full test run.

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `lib/smtp/actions-core.ts applyVerifiedConfig` | `lib/data/smtp.ts getSmtpConfigForUser` | fetch caller's own stored row when password blank | ✓ WIRED | Confirmed at `actions-core.ts:98`; import added to existing `../data/smtp` import line |
| `lib/smtp/actions-core.ts applyVerifiedConfig` | `lib/crypto decrypt` | decrypt stored triple, substitute before verify/persist | ✓ WIRED | Confirmed at `actions-core.ts:110-114`; `decrypt` imported from `../crypto` alongside existing `encrypt` import |
| `components/smtp/smtp-wizard.tsx` | `lib/smtp/schema.ts smtpEditFormSchema` | `zodResolver` picks edit schema when `isEdit` | ✓ WIRED | Confirmed at `smtp-wizard.tsx:92-94`; import added alongside `smtpFormSchema` |

All previously-verified key links (Clerk provider wiring, verify→errors classification, DAL→DB, dashboard→DAL, Server Action call chains) re-checked with a quick grep pass — no regressions found.

### Behavioral Spot-Checks (run directly by this verifier)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| SMTP actions test suite | `node --import tsx --test lib/smtp/actions.test.ts` | 10 pass, 0 fail | ✓ PASS |
| Full lib test suite | `node --import tsx --test 'lib/**/*.test.ts'` | 87 pass, 0 fail | ✓ PASS |
| Type-check | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Reproduction flip: base schema still rejects blank password (create flow unaffected) | `smtpFormSchema.safeParse({...password:""})` | `success: false` | ✓ PASS |
| Reproduction flip: edit schema now accepts blank password | `smtpEditFormSchema.safeParse({...password:""})` | `success: true` | ✓ PASS |
| Commits exist and match plan description | `git show --stat 914a780`, `git show --stat 987eb9f` | Both present, file lists match plan/summary | ✓ PASS |
| Debt-marker scan on the 4 delta files | `grep -n "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across schema.ts, actions-core.ts, smtp-wizard.tsx, actions.test.ts | 0 matches | ✓ PASS |
| Staging auth-gate regression | `curl -sI https://mailmerge.robindarlington.com/dashboard`, `/settings/smtp` | both `307` → `/sign-in` | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention exists in this repo and no plan declares probe scripts. Skipped — not applicable (Next.js app, not a CLI/migration-probe project). Same as initial verification.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| AUTH-01 | 02-01, 02-04, 02-07 | User can sign up and sign in via Clerk | ✓ SATISFIED (regression-checked) | `proxy.ts` unchanged; live staging re-check confirms redirect behavior intact |
| AUTH-02 | 02-03, 02-05 | All user data scoped to signed-in user | ✓ SATISFIED (regression-checked) | `lib/data/smtp.ts` unchanged; cross-tenant isolation tests still pass in the 87-test run |
| AUTH-03 | 02-01, 02-07 | Unauthenticated users redirected to sign-in for all app routes | ✓ SATISFIED (regression-checked) | Live staging re-check: `/`, `/dashboard`, `/settings/smtp` all `307` |
| SMTP-01 | 02-02, 02-06 | User can enter SMTP server details | ✓ SATISFIED (regression-checked) | `step-details.tsx` unchanged; all 6 fields present |
| SMTP-02 | 02-02, 02-06 | Explicit TLS mode, not inferred from port | ✓ SATISFIED (regression-checked) | `secure: z.boolean()` unchanged in both schema variants |
| SMTP-03 | 02-02 | Live connection check distinguishing auth vs host/port vs TLS | ✓ SATISFIED (regression-checked) | `classifyVerifyError`/`verifySmtp` unchanged; 3 live fixture tests pass. WARNING (WR-01, non-blocking, carried forward): substring classifier can misfile a connection failure as TLS when the hostname contains "ssl"/"tls" |
| SMTP-04 | 02-03, 02-05, **02-08, 02-09** | Credentials encrypted at rest, reused across sessions, password never returned/logged | ✓ SATISFIED (gap closed) | Encryption/redaction unchanged and solid; the "reused across sessions" edit-path gap (CR-01) is now closed by 02-08's merge branch, test-proven and human-UAT-confirmed (02-09) |
| SMTP-05 | 02-05, 02-06, 02-07 | Onboarding completes only after successful validation, with optional test-send | ✓ SATISFIED (regression-checked) | `applyVerifiedConfig` create-path behavior unchanged; test-send flow unchanged |

No orphaned requirements — all 8 declared REQ-IDs for Phase 2 are covered by at least one plan (02-01 through 02-09) and were checked above.

**Note on REQUIREMENTS.md checkbox hygiene (pre-existing, not introduced by this phase's gap closure):** The `- [ ]` / `- [x]` checkboxes in REQUIREMENTS.md's "v1 Requirements" section only show AUTH-02 and SMTP-04 as checked, while AUTH-01, AUTH-03, SMTP-01, SMTP-02, SMTP-03, and SMTP-05 remain unchecked — even though the Traceability table's Status column and this verification both mark all 8 as satisfied/complete. This is a documentation-sync gap in REQUIREMENTS.md itself (present since before the initial 2026-07-11 verification, unrelated to plans 02-08/02-09), not a code defect. Flagged as INFO — recommend a housekeeping pass to sync the checkboxes with the Traceability table.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `lib/smtp/actions-core.ts` | 110-114 (new in 02-08, WR-08) | `decrypt()` call has no try/catch; a GCM auth-tag mismatch (e.g. `CREDENTIAL_ENC_KEY` rotated/misconfigured) throws through the "never rejects" Server Action contract, compounding the pre-existing WR-02 client-lockup (unhandled promise rejection leaves the wizard permanently disabled) | ⚠ Warning (non-blocking) | Narrow, ops-triggered edge case (key rotation/DB restore with wrong key); does not affect the normal blank-password-edit path proven by tests and human UAT; code review recommends a try/catch converting to a validation-shaped error |
| `lib/smtp/actions-core.ts` | 97-117 (new in 02-08, WR-09) | Blank-password-keep merge dials whatever `host`/`port` the submitted form specifies using the decrypted stored password — a session-holding attacker who does not know the SMTP password could redirect it, via SMTP AUTH, to a host they control | ⚠ Warning (non-blocking) | Requires an already-compromised session (not a new unauthenticated attack surface); code review flags as a hardening recommendation (require password re-entry when host/username changes), not a critical/blocking finding; 0 critical findings in the delta re-review |
| `lib/smtp/schema.ts` | 72-74 | (Resolved) Comment previously claimed an edit-mode optional-password behavior that didn't exist | — | Now accurate — comment corrected as part of 02-08; no longer an anti-pattern |

0 debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) in the 4 files this gap-closure phase modified. WR-01 through WR-07 and IN-01 through IN-09 are carried forward unchanged from the initial review (already surfaced as non-blocking warnings/info in the prior verification) — re-confirmed still present and still non-blocking for the phase goal.

### Human Verification Required

None. The one outstanding human-verification item from the prior VERIFICATION.md (live wizard walkthrough confirming the CR-01 fix) was satisfied by plan 02-09: the user approved the checkpoint ("approved", 2026-07-12) after confirming both the positive case (blank-password connection-field edit saves) and the negative case (wrong typed password still fails) against a real SMTP server on local dev.

**Note (informational, not a re-opened gap):** `02-09-SUMMARY.md` records a follow-up the user flagged immediately after approval — on the production/staging Coolify deployment, SMTP verification initially failed with a connection-classified error ("can't connect to SMTP server") even with valid details, diagnosed as a VPS egress/DNS issue rather than a regression in the 02-08 code path, and tracked separately against the 02-07 staging-deploy criteria rather than this gap. Per the current session's context, this was subsequently confirmed working on the production deployment using port 587/STARTTLS. No commit or planning-doc update in this repository yet records that resolution explicitly — this verification did not find a corresponding artifact (git log, STATE.md, or a new checkpoint file) documenting the fix. This does not block Phase 2's goal (CR-01's blank-password edit merge, the subject of this re-verification, is fully code- and human-confirmed independent of that egress question), but it should be captured in STATE.md/02-07's tracking as a closure note for full auditability. Recommend a small documentation follow-up, not a code gap.

### Gaps Summary

No gaps remain. All 7 must-haves (6 ROADMAP success criteria + the plan-declared CR-01 edit-flow must-have) are independently verified against the current codebase, an 87/87-passing test suite run directly by this verifier, git history, and a live staging HTTP check performed today. The CR-01 fix was verified at all three levels: exists (schema/action/wizard changes match the plan exactly), substantive (the merge branch does real userId-scoped lookup + decrypt + substitution, not a stub), and wired (resolver → schema → parse → merge → verify → persist chain confirmed end-to-end, plus human UAT on a live SMTP server). The code review's two new delta warnings (WR-08 uncaught decrypt throw, WR-09 session-hijack SMTP-redirect exfiltration) are legitimate hardening recommendations but are explicitly classified as non-critical by the review (0 critical findings) and do not prevent the phase goal — "onboard and persist your own SMTP server... credentials encrypted at rest, reused across sessions, never exposed to the client or logs" — from holding for the normal user flow this phase targets. They are appropriate candidates for a future hardening pass, not blockers to closing Phase 2.

One informational note (not a gap): the production Coolify SMTP-egress issue flagged in 02-09-SUMMARY.md lacks a corresponding resolution artifact in this repository as of this verification, even though the current session's context states it was subsequently confirmed working. Recommend a documentation follow-up to close that loop formally.

---

*Verified: 2026-07-12*
*Verifier: Claude (gsd-verifier)*
