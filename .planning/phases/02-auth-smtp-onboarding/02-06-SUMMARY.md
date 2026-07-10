---
phase: 02-auth-smtp-onboarding
plan: 06
subsystem: ui
tags: [react, next, react-hook-form, zod, shadcn, clerk, smtp, wizard]

# Dependency graph
requires:
  - phase: 02-05
    provides: verifyAndSave / updateFromFields / sendTestEmail Server Actions + ActionResult contract
  - phase: 02-03
    provides: getSmtpConfigForUser + toSmtpConfigDto (password-free DTO)
  - phase: 02-02
    provides: smtpFormSchema shared zod schema (client + server validation)
  - phase: 02-01
    provides: shadcn component stack (form, radio-group, alert, collapsible, sonner)
  - phase: 02-04
    provides: authenticated app shell + dashboard soft-gate entry point
provides:
  - Three-step SMTP onboarding wizard (details -> verify -> test-send)
  - Edit flow on the same page (blank-password prefill, from-only vs connection routing)
  - Field-anchored verify errors + one-click TLS switch
  - Skippable test-send to the user's own address
affects: [campaign-compose, csv-upload, send-batch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wizard owns the single useForm instance; step components receive it as a prop so a verify failure can setError on step-1 controls"
    - "zod coerce input/output divergence handled by casting the resolver to the output type (Resolver<SmtpFormValues>)"
    - "Server-Action ActionResult mapped to RHF setError by error.field (auth/hostPort/tlsMode/form)"

key-files:
  created:
    - app/(app)/settings/smtp/page.tsx
    - components/smtp/smtp-wizard.tsx
    - components/smtp/step-details.tsx
    - components/smtp/step-verify.tsx
    - components/smtp/step-test-send.tsx
  modified:
    - app/(app)/layout.tsx

key-decisions:
  - "Details form and verify action share one screen so field-anchored errors point at the exact control; the stepper's Verify marker lights while a verify is in flight"
  - "Cast zodResolver to Resolver<SmtpFormValues> because port uses z.coerce (input type diverges from output)"
  - "from-only edit path uses form.trigger([from_addr, from_name]) + updateFromFields, bypassing full-schema validation (which requires a password)"

patterns-established:
  - "Pattern: client Server-Action error -> RHF setError field anchoring via a closed error.field union"
  - "Pattern: message-only error.raw surfaced through a Collapsible 'Show technical details' (never credentials)"

requirements-completed: [SMTP-01, SMTP-02, SMTP-05]

# Metrics
duration: ~35min
completed: 2026-07-11
---

# Phase 2 Plan 06: SMTP Onboarding Wizard Summary

**Three-step gated SMTP wizard (details -> live verify-then-save -> skippable test-send) plus the same-page edit flow, wired to the 02-05 Server Actions with field-anchored errors, a one-click TLS switch, and a password-free edit prefill.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2 of 3 complete (Task 3 is a human-verify checkpoint — pending)
- **Files created:** 5
- **Files modified:** 1

## Accomplishments
- `/settings/smtp` RSC loads the caller's config via the userId-scoped DAL and hands the client only the password-free DTO + Clerk primary email.
- `SmtpWizard` owns the shared RHF form, a 3-step stepper, and the verify-in-flight state; each step gates the next (D-01).
- `StepDetails` renders all six SMTP fields with an explicit TLS-mode radio (SMTP-01/SMTP-02) and a blank-password edit prefill with "Leave blank to keep your current password" (D-07).
- `StepVerify` runs `verifyAndSave`, maps `error.field` onto the anchored controls via `setError` (D-06), offers the one-click "Switch to {mode} & verify" on a TLS suggestion (D-05), and routes from-only edits through `updateFromFields` without a verify (D-08).
- `StepTestSend` sends a skippable test email to the user's own address (D-03/SMTP-05) with a success toast and a settings-preserving failure alert.

## Task Commits

1. **Task 1: Wizard shell + stepper + step 1 details form** - `764b7d9` (feat)
2. **Task 2: Verify (errors + TLS switch) + test-send (skippable) wiring** - `d4715ef` (feat)
3. **Task 3: Human-verify checkpoint** - PENDING (requires a real SMTP server + Clerk keys)

## Files Created/Modified
- `app/(app)/settings/smtp/page.tsx` - RSC entry/edit page; loads DTO, passes it + test-email default to the client wizard.
- `components/smtp/smtp-wizard.tsx` - Client shell: owns the RHF form, stepper, stage/pending state, and D-08 connection-dirty routing.
- `components/smtp/step-details.tsx` - Step 1 fields + explicit TLS radio + blank-password edit prefill.
- `components/smtp/step-verify.tsx` - Step 2 verify-then-save, field-anchored errors, TLS switch, from-only edit shortcut.
- `components/smtp/step-test-send.tsx` - Step 3 skippable test-send with success toast / failure alert.
- `app/(app)/layout.tsx` - Mounted the Sonner `<Toaster />` (deviation; see below).

## Decisions Made
- Combined the details form and verify action on one screen (best UX for field-anchored errors); the stepper's "Verify" marker reflects the in-flight verify while the fields disable.
- Cast `zodResolver(smtpFormSchema)` to `Resolver<SmtpFormValues>`: `port` uses `z.coerce.number()`, so the schema's input type (`port: unknown`) diverges from its output (`port: number`); driving the form with the clean output type and casting the resolver keeps every step's prop type as `UseFormReturn<SmtpFormValues>`.
- The from-only edit path validates only `from_addr`/`from_name` (the full schema requires a password), matching `updateFromFields`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Mounted the Sonner Toaster in the app shell**
- **Found during:** Task 2 (test-send + from-only success toasts)
- **Issue:** The plan/UI-SPEC specify Sonner success toasts, but no `<Toaster />` was mounted anywhere in the app tree, so `toast.success(...)` would render nothing.
- **Fix:** Added `import { Toaster } from "@/components/ui/sonner"` and mounted `<Toaster />` in `app/(app)/layout.tsx` (inside the shell, once).
- **Files modified:** `app/(app)/layout.tsx`
- **Verification:** `npx --no-install tsc --noEmit` exits 0; the toast host is present on every signed-in page.
- **Committed in:** `d4715ef` (Task 2 commit)

**2. [Rule 3 - Blocking] Cast the zod resolver to the form's output type**
- **Found during:** Task 1 (useForm typing)
- **Issue:** `port: z.coerce.number()` makes the resolver's input type (`port: unknown`) incompatible with `useForm<SmtpFormValues>`, producing TS2322 errors that would have forced `port: unknown` to propagate through every step's props.
- **Fix:** Cast `zodResolver(smtpFormSchema) as unknown as Resolver<SmtpFormValues>`; the port control renders/edits as a string and the shared schema coerces it on submit (and again authoritatively server-side).
- **Files modified:** `components/smtp/smtp-wizard.tsx`
- **Verification:** `npx --no-install tsc --noEmit` exits 0.
- **Committed in:** `764b7d9` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking). **Impact:** Necessary to make the specified toasts render and to keep the shared schema unforked. No scope creep.

## Issues Encountered

- **Password grep gate literal count is non-zero (12), but there is no leak.** The verification's heuristic `grep ... | grep -c .` counts documentation comments, the `autoComplete="new-password"` hint, the `AUTH_MSG` copy string ("Username or password rejected…"), the `setError("password", …)` error-anchoring call, `dirty.password` change-tracking, and the intentional blank `password: ""` prefill. Verified semantically: `grep -rnE 'initial[^;]*password|\.password_'` finds only a comment, and the only `password:` assignment in client state is `password: ""` (D-07 blank). The DTO type has no password field, so any stored-password read would fail `tsc`. T-2-CRED / D-07 hold.

## User Setup Required

None in code — but the Task 3 checkpoint below requires the operator to supply real Clerk keys and a real SMTP server to exercise the flow end-to-end.

## Next Phase Readiness

- SMTP onboarding is functionally complete pending the human-verify walkthrough. A fresh account can go from no-config to a verified, encrypted, reusable SMTP config with a confirmed test delivery.
- **Blocker to full completion:** Task 3 is a `checkpoint:human-verify` (gate="blocking") — hands-on wizard + edit-flow testing against a real SMTP server, plus a Network-tab confirmation that no password appears in any client payload. This cannot be automated in the worktree.

## TDD Gate Compliance

Not a TDD plan (`type: execute`). The lib-layer contracts this UI consumes (02-02/02-05) carry their own tests; this plan is presentational wiring verified by `tsc` + the human checkpoint.

## Self-Check: PENDING

Files and commits verified below; plan not marked complete because Task 3 (human-verify) is unresolved.

---
*Phase: 02-auth-smtp-onboarding*
*Completed (automatable tasks): 2026-07-11*
