---
phase: 02-auth-smtp-onboarding
plan: 01
subsystem: auth
tags: [clerk, auth, nextjs-16, middleware, shadcn, onboarding]
status: awaiting-checkpoint
requires:
  - Phase 1 lib/ foundation (crypto, db, core) — untouched by this plan
  - Clerk development-instance keys (external — user must supply before checkpoint)
provides:
  - Clerk route protection (proxy.ts) for all non-public paths (AUTH-03)
  - ClerkProvider-wrapped root layout (shadcn theme)
  - Dedicated /sign-in and /sign-up pages (AUTH-01)
  - Root `/` -> /dashboard redirect
  - lib/config.ts HIRE_ME_URL constant (D-12)
  - All Phase-2 npm deps + shadcn components (no later plan touches package.json)
affects:
  - package.json / package-lock.json (owned by this plan for the whole phase)
  - app/layout.tsx, app/page.tsx
tech-stack:
  added:
    - react-hook-form@^7.81.0
    - "@hookform/resolvers@^5.4.0"
    - "@clerk/ui@^1.25.2 (shadcn theme for Clerk components)"
    - smtp-server@^3.19.2 (dev — test fixtures)
    - "@types/smtp-server (dev)"
  patterns:
    - "proxy.ts (Next 16 middleware convention) + auth.protect() for non-public paths"
    - "ClerkProvider inside <body>, not around <html>"
    - "shadcn radix-nova components via CLI (unified radix-ui package imports)"
key-files:
  created:
    - proxy.ts
    - app/sign-in/[[...sign-in]]/page.tsx
    - app/sign-up/[[...sign-up]]/page.tsx
    - lib/config.ts
    - components/ui/ (16 shadcn components incl. hand-authored form.tsx)
    - hooks/use-mobile.ts
  modified:
    - app/layout.tsx
    - app/page.tsx
    - .env.example
    - package.json
    - package-lock.json
decisions:
  - "Hand-authored components/ui/form.tsx because the radix-nova style ships an empty form registry item (CLI creates no file)."
  - "Did NOT install @clerk/themes — superseded by @clerk/ui per RESEARCH State of the Art."
metrics:
  tasks_completed: 3
  tasks_total: 4
  duration: ~10m
  completed_date: 2026-07-10
---

# Phase 2 Plan 01: Clerk Auth Slice + Phase-2 Dependencies Summary

Delivered the Clerk authentication slice for Next.js 16 (proxy.ts route protection, ClerkProvider root layout with the `@clerk/ui` shadcn theme, dedicated `/sign-in` + `/sign-up` pages, and a `/` -> `/dashboard` redirect) and installed every npm package and shadcn component the rest of Phase 2 needs — so no later plan has to touch `package.json`.

## What Was Built

- **Task 1 — Dependencies + shadcn components** (`chore` commit `0326527`): Installed `react-hook-form@7.81.0`, `@hookform/resolvers@5.4.0`, `@clerk/ui@1.25.2` (runtime) and `smtp-server@3.19.2` + `@types/smtp-server` (dev). Added the shadcn components `sidebar button card input label radio-group alert dialog sonner skeleton separator badge form collapsible`; the sidebar pulled in `tooltip`, `sheet`, and `hooks/use-mobile.ts`. `@clerk/themes` deliberately NOT installed.
- **Task 2 — proxy.ts + env template** (`feat` commit `51c4c16`): Created `proxy.ts` at repo root exporting `clerkMiddleware`; `PUBLIC_PATHS` allows `/sign-in` + `/sign-up`, everything else calls `await auth.protect()`. Verbatim RESEARCH matcher (skips `_next`, static assets incl. `.csv`, plus `(api|trpc)` and `/__clerk/`). Extended `.env.example` with the four `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `SIGN_UP_URL` / two `*_FALLBACK_REDIRECT_URL` vars (Pitfall 2 workaround for clerk/javascript#8302).
- **Task 3 — Layout, auth pages, redirect, config** (`feat` commit `ff3d3f8`): Wrapped `{children}` in `<ClerkProvider appearance={{ theme: shadcn }}>` inside `<body>`; added `/sign-in` and `/sign-up` catch-all pages (`<SignIn/>`/`<SignUp/>`, centered, 3xl top offset); replaced `app/page.tsx` with a server `redirect("/dashboard")`; added `lib/config.ts` exporting the `HIRE_ME_URL` placeholder (D-12).

## Verification

- `npx --no-install tsc --noEmit` exits 0 after every task.
- Task-level automated `verify` blocks (deps present, `proxy.ts` contains `clerkMiddleware`+`auth.protect` and NOT `createRouteMatcher`, `.env.example` vars present, `ClerkProvider`/`redirect("/dashboard")`/`HIRE_ME_URL` present) all pass.
- `no middleware.ts` at repo root confirmed (Pitfall 1).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] radix-nova `form` component ships no files — hand-authored `components/ui/form.tsx`**
- **Found during:** Task 1
- **Issue:** `npx shadcn add form` exits without creating `components/ui/form.tsx` under the project's `radix-nova` style; the registry item `styles/radix-nova/form.json` contains only a name/type stub with no `files` array. The plan's acceptance criteria require `components/ui/form.tsx` to exist.
- **Fix:** Hand-authored `components/ui/form.tsx` using the standard shadcn react-hook-form wrapper (`Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormDescription`, `FormMessage`, `useFormField`), adapted to the radix-nova import conventions (`Slot` from the unified `radix-ui` package, local `@/components/ui/label`). This is not a package-manager install, so no legitimacy checkpoint applies.
- **Files modified:** components/ui/form.tsx
- **Commit:** 0326527

**2. [Rule 3 - Blocking] Reworded proxy.ts JSDoc to satisfy the literal `createRouteMatcher`-absent gate**
- **Found during:** Task 2
- **Issue:** The plan's automated verify greps `proxy.ts` for the literal string `createRouteMatcher` and fails if present. My explanatory JSDoc mentioned the deprecated helper by name in prose, tripping the naive regex.
- **Fix:** Reworded the comment to describe the deprecated helper without using the literal token; the code never used it. Gate now passes.
- **Files modified:** proxy.ts
- **Commit:** 51c4c16

## Checkpoint Status

Task 4 (`checkpoint:human-verify`, gate=blocking) is PENDING. It cannot run inside the worktree: it requires real Clerk development-instance keys in `.env` and a running `next dev` server for an end-to-end sign-up/sign-in walkthrough plus the signed-out `/dashboard` -> `/sign-in` redirect check. `npm run build` also needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` present (inlined at build, Pitfall 3). Implementation for all three preceding tasks is complete and committed; only human verification remains.

## Known Stubs

- `HIRE_ME_URL` in `lib/config.ts` is an intentional placeholder (`https://example.com/hire-me`); D-12 documents that BRAND-01 in Phase 9 flips this single value. Not a blocking stub.

## Follow-ups / Notes for Later Plans

- `/dashboard` does not exist yet — it ships in plan 02-04. Until then a signed-in user hitting `/` (or `/dashboard`) sees a 404; this is expected per the plan.
- `npm audit` reports 18 moderate advisories from the transitive dependency tree; none are in scope for this plan (logged here, not fixed).

## Self-Check: PASSED

- proxy.ts — FOUND
- app/sign-in/[[...sign-in]]/page.tsx — FOUND
- app/sign-up/[[...sign-up]]/page.tsx — FOUND
- lib/config.ts — FOUND
- components/ui/form.tsx — FOUND
- Commit 0326527 — FOUND
- Commit 51c4c16 — FOUND
- Commit ff3d3f8 — FOUND
