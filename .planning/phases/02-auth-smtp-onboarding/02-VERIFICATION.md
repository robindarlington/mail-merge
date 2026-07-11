---
phase: 02-auth-smtp-onboarding
verified: 2026-07-11T21:40:00Z
status: gaps_found
score: 6/7 must-haves verified (6 ROADMAP success criteria hold; 1 plan-declared must-have fails)
overrides_applied: 0
gaps:
  - truth: "Editing a saved SMTP config re-routes connection-field changes through verify while leaving the password blank (D-07/D-08, declared must-have of 02-06-PLAN.md and 02-05-PLAN.md)"
    status: failed
    reason: >
      The UI promises "Leave blank to keep your current password" in edit mode
      (components/smtp/step-details.tsx:156,162) and the schema comment claims
      "Edit flow makes this optional" (lib/smtp/schema.ts:72-73), but
      `smtpFormSchema.password` is `z.string().min(1, "Password is required")`
      unconditionally — there is no edit-mode schema variant, and
      `applyVerifiedConfig` (lib/smtp/actions-core.ts) has no
      fetch-stored-password-when-blank merge path. Reproduced independently:
      parsing a valid edit payload with `password: ""` through
      `smtpFormSchema.safeParse` fails with "Password is required". Any user
      who edits a connection field (host/port/secure/username) without
      re-typing their password cannot save — the wizard's own D-08 routing
      correctly sends them to `verifyAndSave`, which then dead-ends on the
      blank-password validation error directly beneath the placeholder that
      told them to leave it blank. No test in lib/smtp/actions.test.ts covers
      a blank-password edit payload. This matches code-review finding CR-01
      (.planning/phases/02-auth-smtp-onboarding/02-REVIEW.md) verbatim and is
      still present in the current tree.
    artifacts:
      - path: "lib/smtp/schema.ts"
        issue: "password field is unconditionally z.string().min(1) — no edit-mode variant exists despite the file's own comment claiming one"
      - path: "lib/smtp/actions-core.ts"
        issue: "applyVerifiedConfig has no branch that loads/decrypts the stored password when the submitted password is blank"
      - path: "components/smtp/step-details.tsx"
        issue: "renders 'Leave blank to keep your current password' placeholder/help text that the backend cannot honor"
    missing:
      - "An edit-mode schema variant (or superRefine) that allows a blank password"
      - "A server-side merge path: when editing and the submitted password is blank, decrypt and substitute the stored password before verify/persist"
      - "A test in lib/smtp/actions.test.ts covering the blank-password edit flow"
human_verification:
  - test: "Sign in on staging (or local dev with a saved SMTP config), open Settings → SMTP, change ONLY the host or port (do not touch the password field, which is blank), and click 'Verify & continue'."
    expected: "The connection re-verifies against the stored password and saves, OR a clear message explains the password must be re-entered — NOT a bare 'Password is required' error under a field that says it can be left blank."
    why_human: "Confirms the CR-01 fix (once applied) end-to-end with a real SMTP server; the codebase-level reproduction above is sufficient to confirm the bug exists today, but confirming the FIX requires a live wizard walkthrough."
---

# Phase 2: Auth + SMTP Onboarding — Verification Report

**Phase Goal (ROADMAP prose):** A signed-in user can onboard and persist their own SMTP server, proven functional by a live connection check, with credentials encrypted at rest and never exposed.

**Phase Goal (user-story form, restated identically across all 7 plans' "Phase Goal" sections and validated by `gsd-sdk query user-story.validate`):** As a signed-in user, I want to onboard and persist my own SMTP server proven functional by a live connection check, so that my credentials are stored encrypted at rest, reused across sessions, and never exposed to the client or logs.

**Verified:** 2026-07-11
**Status:** gaps_found
**Re-verification:** No — initial verification

**Note on MVP-mode framing:** `gsd-sdk query roadmap.get-phase 2` reports `mode: mvp`, but the ROADMAP.md `**Goal:**` line for Phase 2 is prose, not "As a X, I want Y, so that Z." format (`user-story.validate` returns `valid: false` against the raw ROADMAP text). However, every plan in this phase independently restates the same valid user story in its "Phase Goal" section (validated `valid: true`), with an explicit note that it is "a faithful restatement" of the ROADMAP prose goal. This verification uses that user story for the User Flow Coverage section below and otherwise proceeds with standard goal-backward verification against the ROADMAP's 6 numbered success criteria and the plans' `must_haves` frontmatter (the two are consistent — no scope was invented or dropped). This is a documentation-process discrepancy (ROADMAP.md not yet reformatted to user-story syntax), not a phase-execution gap, and does not by itself block verification.

## User Flow Coverage

User story: «As a signed-in user, I want to onboard and persist my own SMTP server proven functional by a live connection check, so that my credentials are stored encrypted at rest, reused across sessions, and never exposed to the client or logs.»

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Sign up / sign in | Visiting the app while signed out redirects to `/sign-in`; Clerk widgets render; a session is established | `proxy.ts` (`clerkMiddleware` + `auth.protect()`); live check: `curl -sI https://mailmerge.robindarlington.com/dashboard` → `307` to `/sign-in`; `/sign-in` → `200` with rendered Clerk `pk_live_...` key | ✓ |
| Land on dashboard | Signed-in user reaches `/dashboard` inside the app shell; fresh account sees a dominant "Set up your SMTP server" callout | `app/(app)/dashboard/page.tsx` (three-state render, `getSmtpConfigForUser` scoped by server-derived `userId`); `app/(app)/layout.tsx` (sidebar + UserButton + footer) | ✓ |
| Enter SMTP details | Wizard step 1 collects host/port/username/password/from-name/from-address + an explicit TLS-mode radio | `components/smtp/step-details.tsx` (all 6 fields, `RadioGroup` for `secure`, `zodResolver(smtpFormSchema)`) | ✓ |
| Live verify | "Verify & continue" dials the real server; failure is field-anchored (auth → username/password, connection → host/port, tls → radio) with a one-click TLS-mode switch; success advances | `components/smtp/step-verify.tsx` (`verifyAndSave`, `setError` per `error.field`, TLS switch `Alert`); `lib/smtp/verify.ts` + `lib/smtp/errors.ts` (85/85 tests incl. 3 live `smtp-server` fixtures) | ✓ |
| Save encrypted, never exposed | Config persists ONLY after a clean verify; password is AES-256-GCM-encrypted; DTO to the client never carries it | `lib/smtp/actions-core.ts` `applyVerifiedConfig` (persist only on `outcome.ok`); `lib/crypto/index.ts` (`aes-256-gcm`, random IV, auth tag); `lib/data/smtp.ts` `toSmtpConfigDto` (explicit-pick, structurally excludes `password_*`); `lib/data/dto.test.ts` (marker-password JSON.stringify absence) | ✓ |
| Optional test-send | Final step offers a skippable test-send to the user's own address; a stale/broken transport fails a classified verify BEFORE any send | `components/smtp/step-test-send.tsx` (`sendTestEmail`, "Skip for now"); `lib/smtp/actions.ts` `sendTestEmail` (`verifyTransport` before `sendOne`) | ✓ |
| Reused across sessions | A previously-saved config reloads on return visits and can be edited without re-entering the password (outcome clause: "reused across sessions") | `app/(app)/settings/smtp/page.tsx` loads `toSmtpConfigDto` for edit prefill — **BUT** editing a connection field (host/port/secure/username) while leaving the password blank fails validation with "Password is required," contradicting the UI's own "Leave blank to keep your current password" promise. Reproduced independently via `smtpFormSchema.safeParse` with `password: ""`. | ✗ |
| Staging deployment | The slice is live and functional on the standing Coolify staging URL | `curl -sI https://mailmerge.robindarlington.com/dashboard` → 307 to sign-in; `/settings/smtp` and `/` also redirect signed-out; `/sign-in` renders 200 with a Clerk key present | ✓ |

7 of 8 user-flow steps verified directly against the live codebase and the live staging deployment. The "reused across sessions" outcome clause is broken specifically for the edit-a-saved-config path — a returning user can view but not safely modify their connection settings without re-supplying the password the UI told them to omit.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|-------|--------|----------|
| 1 | Sign up/sign in via Clerk; unauthenticated app-route requests redirect to sign-in | ✓ VERIFIED | `proxy.ts` (`clerkMiddleware`, `auth.protect()`, no deprecated `createRouteMatcher`); live: signed-out `/`, `/dashboard`, `/settings/smtp` all 307→`/sign-in` on staging; human checkpoint 02-01 approved |
| 2 | Every data access scoped to signed-in `userId`; one user can never read/mutate another's records | ✓ VERIFIED | `lib/data/smtp.ts` — every function's first param is `userId`; no unscoped `smtp_configs` query exists anywhere else in the tree (grep-confirmed); `lib/data/smtp.test.ts` cross-tenant isolation tests pass (11/11 relevant tests in the 85-test suite) |
| 3 | User enters SMTP host/port/username/password/from-name/from-address + explicit TLS mode; onboarding completes only after live `transport.verify()` succeeds; errors distinguish auth vs host/port vs TLS | ✓ VERIFIED (create flow) | `lib/smtp/schema.ts` (`smtpFormSchema`, explicit `secure` boolean never inferred from port), `lib/smtp/verify.ts` (`verifySmtp`, `ONBOARDING_TIMEOUTS`), `lib/smtp/errors.ts` (`classifyVerifyError`); 3 live `smtp-server` fixture tests pass (auth/connection-refused-<15s/tls); `applyVerifiedConfig` persists only on `outcome.ok` |
| 4 | Credentials AES-256-GCM-encrypted at rest, reused across sessions, password never in client response or log | ⚠ PARTIAL | Encryption correct (`lib/crypto/index.ts`: `createCipheriv("aes-256-gcm", ...)`, random 12-byte IV, auth tag verified on decrypt); DTO redaction structurally sound (`toSmtpConfigDto` explicit-pick, `dto.test.ts` marker-password absence proven); grep gates on `app/(app)` and `lib/smtp` for `password_enc\|password_iv\|password_tag` return 0 outside the write/decrypt paths. **However** "reused across sessions" breaks for the edit path — see gap below; a saved config cannot be edited (connection fields) without re-entering the password |
| 5 | Final onboarding step offers a test-send to the user's own address, confirming delivery | ✓ VERIFIED | `components/smtp/step-test-send.tsx`, `lib/smtp/actions.ts sendTestEmail` (`verifyTransport` before `sendOne`, decrypt server-side only, message-only failure returns); 8/8 actions tests pass incl. verify-before-send ordering and redaction assertions |
| 6 | Phase slice deployed to the standing Coolify staging URL and works there | ✓ VERIFIED | Live `curl` against `https://mailmerge.robindarlington.com`: sign-in page renders (200, `pk_live_...` Clerk key present — production instance, a deliberate upgrade over D-13's dev-instance default per user's choice), all app routes redirect signed-out traffic; `Dockerfile` build ARGs for `NEXT_PUBLIC_CLERK_*` present, `CLERK_SECRET_KEY` absent from Dockerfile (grep-confirmed), present only in `docker-compose.yml` runtime env; `Dockerfile` `CMD` runs `scripts/migrate.ts` before `node server.js` (post-merge fix `6445bf5`); human checkpoints 02-07 (deploy + smoke) approved |

**Score (ROADMAP SCs only):** 5.5/6 — SC4 holds for its literal "encrypted, never exposed" clause but the "reused across sessions" sub-clause is broken for the edit flow.

### Additional Plan-Declared Must-Have (not literally a numbered ROADMAP SC, but explicitly declared in 02-05-PLAN.md and 02-06-PLAN.md frontmatter `must_haves.truths`, and therefore in scope per the "plans may add, never subtract" rule)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 7 | "Editing a saved config prefills DTO values with a BLANK password; changing connection fields re-routes through verify; changing only from-fields saves directly" (D-07/D-08) | ✗ FAILED | See Gaps below. The from-only path works correctly (`updateFromFields`, no verify, `verified_at` untouched — 3 passing tests). The connection-field-edit-with-blank-password path is broken: `smtpFormSchema.password` requires `min(1)` unconditionally and no merge-with-stored-password path exists in `applyVerifiedConfig`. Independently reproduced. |

**Combined score: 6/7 must-haves verified** (treating SC4 as verified for its literal wording since the encryption/redaction half is solid, and counting the edit-flow defect once as item 7 rather than double-penalizing SC4).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `proxy.ts` | Clerk middleware protecting all non-public routes | ✓ VERIFIED | `clerkMiddleware` + `auth.protect()`; no `middleware.ts` exists; matcher covers all non-static paths + API + `/__clerk/` |
| `app/layout.tsx` | ClerkProvider wraps children inside `<body>` | ✓ VERIFIED | Confirmed inside `<body>`, `shadcn` theme from `@clerk/ui/themes` |
| `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx` | Dedicated Clerk auth pages | ✓ VERIFIED | Render `<SignIn/>`/`<SignUp/>`; live-confirmed on staging (200 OK) |
| `lib/config.ts` | `HIRE_ME_URL` placeholder constant | ✓ VERIFIED | Exists, exported, consumed by `SiteFooter` |
| `lib/smtp/schema.ts` | Shared zod SMTP form schema | ✓ VERIFIED (create) / ✗ INCOMPLETE (edit) | Validates all 6 fields + SSRF host-literal rejection; no edit-mode variant despite its own comment claiming one exists |
| `lib/smtp/errors.ts` | `classifyVerifyError` | ✓ VERIFIED | 11/11 table-driven tests pass; WR-01 (review) notes a real-world hostname substring misclassification edge case — not a phase-blocking issue, flagged as WARNING |
| `lib/smtp/verify.ts` | `verifySmtp` with short timeouts + TLS auto-retry | ✓ VERIFIED | 3/3 live-fixture tests pass; `requireTLS: !secure`; `transport.close()` in finally; no `rejectUnauthorized: false` |
| `lib/data/smtp.ts` | userId-scoped DAL + `toSmtpConfigDto` | ✓ VERIFIED | Every function `userId`-first; DTO structurally excludes password triple; 11 tests pass |
| `drizzle/0001_shiny_stature.sql` | Committed migration for `smtp_configs_user_uq` | ✓ VERIFIED | `CREATE UNIQUE INDEX` present; journal has idx-1 entry; Dockerfile `CMD` applies migrations on container start |
| `lib/smtp/actions.ts` + `lib/smtp/actions-core.ts` | verifyAndSave / updateFromFields / sendTestEmail Server Actions | ✓ VERIFIED (structure) / ✗ FAILED (edit-with-blank-password behavior) | `"use server"` module exports only the 3 auth-guarded actions (post-merge IDOR fix `fd4e22a` confirmed applied — `actions-core.ts` has no directive); each action re-derives `userId`; but `applyVerifiedConfig` has no blank-password-keeps-stored path |
| `app/(app)/layout.tsx`, `components/app-sidebar.tsx`, `components/site-footer.tsx` | Authenticated shell | ✓ VERIFIED | Sidebar (Dashboard + SMTP Settings), `UserButton`, `SiteFooter` with `HIRE_ME_URL` all present and wired |
| `app/(app)/dashboard/page.tsx` | Soft-gate / summary / re-verify states | ✓ VERIFIED (states 1–2) / ℹ INFO (state 3 unreachable) | State 1 (no config) and state 2 (verified) both reachable and correctly rendered. State 3 ("re-verify required," `verified_at === null`) is dead code — no code path currently clears `verified_at` (matches code-review IN-01). Not a blocker: the badge renders correctly if the state is ever reached; the trigger is simply unused today. |
| `Dockerfile`, `docker-compose.yml` | Build-time Clerk ARGs, runtime-only secrets | ✓ VERIFIED | `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (+4 URL ARGs) promoted to ENV before `RUN npm run build`; no `CLERK_SECRET_KEY` ARG/ENV in Dockerfile; compose injects it as `web.environment` only. ⚠ WARNING: `worker` service still has its own `build:` block sharing the same `mail-merge:skeleton` tag as `web` (code-review WR-06) — a build-order race could theoretically produce a web image missing the inlined publishable key. Did not manifest on the current live staging deploy (confirmed serving `pk_live_...`), but is a latent risk, not fixed by this phase. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `app/layout.tsx` | `@clerk/nextjs ClerkProvider` | provider wraps children inside `<body>` | ✓ WIRED | Confirmed |
| `proxy.ts` | `auth.protect()` | non-public path gate | ✓ WIRED | Confirmed; live-tested |
| `lib/smtp/verify.ts` | `lib/core/send.ts createSmtpTransport` | extended transport factory | ✓ WIRED | `requireTLS`/timeout fields passed through |
| `lib/smtp/verify.ts` | `lib/smtp/errors.ts classifyVerifyError` | classify a rejected verify() | ✓ WIRED | Confirmed in code + tests |
| `lib/data/smtp.ts` | `@/lib/db (db client)` | sole SQLite opener | ✓ WIRED | No `new Database` anywhere in `lib/data` |
| `lib/data/smtp.ts upsertSmtpConfig` | `smtp_configs.userId` unique index | `onConflictDoUpdate` target | ✓ WIRED | Index present on disk (`sqlite_master`-equivalent: migration SQL confirmed, journal updated) |
| `app/(app)/dashboard/page.tsx` | `lib/data/smtp.ts getSmtpConfigForUser` | server-side fetch for callout vs summary | ✓ WIRED | Confirmed |
| `components/site-footer.tsx` | `lib/config.ts HIRE_ME_URL` | import constant | ✓ WIRED | Confirmed |
| `lib/smtp/actions.ts verifyAndSave` | `lib/smtp/verify.ts verifySmtp` | verify before persist | ✓ WIRED | Confirmed; delegates through `actions-core.ts applyVerifiedConfig` |
| `lib/smtp/actions.ts sendTestEmail` | `lib/core/send.ts verifyTransport + sendOne` | verify-before-send | ✓ WIRED | Confirmed; `transport.close()` in finally |
| `components/smtp/step-verify.tsx` | `lib/smtp/actions.ts verifyAndSave` | Server Action call → setError per field | ✓ WIRED | Confirmed; also confirmed the from-only edit path correctly calls `updateFromFields` instead |
| `components/smtp/step-test-send.tsx` | `lib/smtp/actions.ts sendTestEmail` | Server Action call, toast/alert | ✓ WIRED | Confirmed |
| `components/smtp/step-details.tsx` | `@hookform/resolvers zodResolver(smtpFormSchema)` | shared schema drives client validation | ⚠ WIRED BUT INCOMPLETE | Wired correctly, but the shared schema itself lacks the edit-mode blank-password allowance it is supposed to have (root cause of the gap) |
| `Dockerfile build stage` | `next build` | ARG → ENV before RUN | ✓ WIRED | Confirmed; live staging serves `pk_live_...`, proving the inlining worked on the actual deploy |
| `docker-compose.yml web.environment` | `CLERK_SECRET_KEY` runtime injection | `${CLERK_SECRET_KEY}` from host env | ✓ WIRED | Confirmed |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full lib test suite | `node --import tsx --test 'lib/**/*.test.ts'` | 85 pass / 0 fail | ✓ PASS |
| Type-check | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Blank-password edit payload rejected (reproducing CR-01) | `smtpFormSchema.safeParse({...password:""})` | `{success:false, issue:"Password is required" on path "password"}` | ✓ PASS (confirms the bug reproduces) |
| Staging unauthenticated redirect | `curl -sI https://mailmerge.robindarlington.com/dashboard` | `307` → `/sign-in?redirect_url=...` | ✓ PASS |
| Staging sign-in page renders with live Clerk key | `curl -s https://mailmerge.robindarlington.com/sign-in \| grep pk_live_` | `pk_live_Y2xlcmsu...` found | ✓ PASS |
| Staging settings/smtp + root also gated | `curl -sI .../settings/smtp`, `curl -sI /` | both `307` → `/sign-in` | ✓ PASS |
| Unique index on disk | `drizzle/0001_shiny_stature.sql` content | `CREATE UNIQUE INDEX smtp_configs_user_uq ON smtp_configs (user_id);` | ✓ PASS |
| Debt-marker scan (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) across all phase-modified files | grep across proxy.ts, app/, components/, lib/smtp, lib/data, Dockerfile, docker-compose.yml | 0 matches | ✓ PASS |
| Unscoped `smtp_configs` query path | grep for `smtp_configs` usage outside `lib/data/smtp.ts` and schema/migrations | none found | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention exists in this repo, and no plan declares probe scripts. Skipped — not applicable to this phase's tooling (Next.js app, not a CLI/migration-probe project).

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| AUTH-01 | 02-01, 02-04, 02-07 | User can sign up and sign in via Clerk | ✓ SATISFIED | `proxy.ts`, sign-in/up pages, live staging confirms working Clerk flow; human checkpoints 02-01/02-07 approved |
| AUTH-02 | 02-03, 02-05 | All user data scoped to signed-in user; multi-tenant isolation on every access | ✓ SATISFIED | `lib/data/smtp.ts` userId-first everywhere; cross-tenant isolation tests pass; Server Actions re-derive `userId` server-side (defense in depth); post-merge IDOR fix (`fd4e22a`) confirmed applied |
| AUTH-03 | 02-01, 02-07 | Unauthenticated users redirected to sign-in for all app routes | ✓ SATISFIED | `proxy.ts` matcher covers all app routes; live-confirmed on staging for `/`, `/dashboard`, `/settings/smtp`. INFO: RSC pages themselves fail open (render page content) rather than redirecting if `userId` is null — currently unreachable since `proxy.ts` is the sole enforcement point and covers all routes, but is a defense-in-depth gap (code review IN-09), not a live violation |
| SMTP-01 | 02-02, 02-06 | User can enter SMTP server details | ✓ SATISFIED | All 6 fields present in `step-details.tsx`, validated by `smtpFormSchema` |
| SMTP-02 | 02-02, 02-06 | Explicit TLS mode set by user, not inferred from port | ✓ SATISFIED | `secure: z.boolean()` explicit; `RadioGroup` in UI; `requireTLS: !secure` carried through transport; never port-inferred anywhere in the codebase (grep-confirmed) |
| SMTP-03 | 02-02 | Live connection check distinguishing auth vs host/port vs TLS failure | ✓ SATISFIED | `classifyVerifyError` + `verifySmtp`; 3 live smtp-server fixture tests confirm all 3 classes; WARNING (WR-01, non-blocking): substring-based classifier can misfile a connection failure as TLS when the hostname itself contains "ssl"/"tls" (e.g. `ssl0.ovh.net`) — a real but narrow misclassification edge case, not a phase-blocking defect |
| SMTP-04 | 02-03, 02-05 | Credentials encrypted at rest (AES-256-GCM), reused across sessions, password never returned/logged | ⚠ PARTIALLY SATISFIED | Encryption + redaction are solid and test-proven. "Reused across sessions" breaks specifically for the edit-a-connection-field path — see gap above. The password never crosses to the client in any case, including the edit failure path (confirmed no leak), so the "never exposed" half fully holds; only the "reused/editable" half is broken |
| SMTP-05 | 02-05, 02-06, 02-07 | Onboarding completes only after successful validation, with optional test-send | ✓ SATISFIED (for its literal wording — the create/onboard flow) | `applyVerifiedConfig` persists only on `verifySmtp` success; `sendTestEmail` offers a skippable test-send with verify-before-send. The SMTP-05 text is specifically about onboarding completion, which works correctly end to end (human checkpoint 02-06 approved for the create path; live staging confirms deployment). The broken behavior is in the EDIT flow, which is a D-07/D-08 UX contract layered on top of SMTP-05 rather than the literal SMTP-05 text itself — still tracked as gap item 7 above because it is an explicit plan must-have. |

No orphaned requirements — all 8 declared REQ-IDs for Phase 2 are covered by at least one plan and were checked above.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `lib/smtp/schema.ts` | 72-73 | Comment claims a behavior ("Edit flow makes this optional") that is not implemented anywhere in the codebase | 🛑 Blocker (tied to gap above) | Misleading to future maintainers; root-cause marker for CR-01 |
| `lib/smtp/errors.ts` | 40-42 | Substring match on error message before code-based checks can misclassify real hostnames containing "ssl"/"tls" | ⚠ Warning | Wrong field-anchoring + wasted alternate-mode probe on affected hostnames (e.g. OVH's `ssl0.ovh.net`); does not block the phase goal |
| `components/smtp/step-verify.tsx`, `step-test-send.tsx` | various | Server Action calls not wrapped in try/catch; a network-level rejection leaves the UI in a permanent pending/disabled state | ⚠ Warning | Recoverable only by page reload; UX degradation, not a security or data-integrity issue |
| `lib/smtp/actions.ts` `sendTestEmail` | 109-135 | `toAddress` accepted with no `z.email()` validation; nodemailer treats a comma-separated string as multiple recipients | ⚠ Warning | Could fan out a single test-send call into multiple deliveries; bounded to the caller's own SMTP; not a cross-tenant issue |
| `lib/smtp/actions.ts` `sendTestEmail` | 109-161 | No rate limit on real sends (verify attempts ARE rate-limited) | ⚠ Warning | Abuse surface if a user's session/script calls it in a loop |
| `lib/smtp/schema.ts` `isPrivateHostLiteral` | 30-55 | Several private/loopback literal encodings (expanded IPv6, short-form IPv4, decimal/hex forms) bypass the SSRF screen | ⚠ Warning | Narrow SSRF-oracle bypass via unusual host literal encodings; the common cases (dotted-quad, `localhost`, `::1`) are covered |
| `docker-compose.yml` | 17-45, 58-69 | `web` and `worker` both declare `build:` blocks sharing the same `mail-merge:skeleton` image tag | ⚠ Warning | Build-order race could theoretically ship a web image without the inlined Clerk key; did not manifest on the current live deploy (verified) |
| `app/globals.css` | 9-59, 140-149 | Unlayered `body` rule overrides `@layer base` — Geist font never renders on body text; dark-mode tokens pinned to light values | ⚠ Warning | Visual/theming defect, not a functional blocker for this phase's goal (human checkpoints for visual review were approved) |

No TBD/FIXME/XXX debt markers found in any phase-modified file (debt-marker gate: 0 matches).

### Human Verification Required

None beyond what is already captured in the `human_verification` frontmatter above (confirming the CR-01 fix once applied). All 4 blocking human checkpoints declared by this phase's plans (02-01, 02-04, 02-06, 02-07) were reported approved by the user, and this verification independently confirmed the staging deployment is live and enforcing auth via direct HTTP checks against `https://mailmerge.robindarlington.com`.

### Gaps Summary

Six of the seven must-haves (including all 6 ROADMAP success criteria in substance) are solidly implemented and independently verified against the live codebase, the 85-test automated suite, and the live staging deployment — not just SUMMARY.md claims. The Clerk auth slice, userId-scoped data layer, SMTP verify engine, encrypted credential storage, test-send flow, and Coolify staging deployment all hold up under direct inspection and live HTTP checks.

The one confirmed gap is narrow but real: the SMTP settings **edit flow** cannot save a change to a connection field (host/port/TLS mode/username) without the user re-typing their password, even though the UI explicitly and specifically tells them they can leave it blank. This is not a hypothetical — it was independently reproduced by parsing a representative edit payload through the actual `smtpFormSchema` in this repository, which rejects a blank password with "Password is required." It corroborates a CRITICAL finding already raised by the phase's own code review (CR-01 in `02-REVIEW.md`) that remains unaddressed in the current tree. This breaks the "reused across sessions" half of SMTP-04 and the explicit D-07/D-08 must-have declared in `02-05-PLAN.md` and `02-06-PLAN.md` frontmatter. The create-onboarding flow (SMTP-05's literal text) and the read-only "view saved config" path are unaffected.

**This looks like an unintentional, unaddressed defect** (the code review already flagged it and proposed a concrete fix) rather than an accepted deviation, so no override is suggested. Recommended next step: a small closure plan implementing the CR-01 fix (edit-mode schema variant + stored-password merge in `applyVerifiedConfig`), which the code review already sketches concretely.

---

*Verified: 2026-07-11*
*Verifier: Claude (gsd-verifier)*
