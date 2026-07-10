---
phase: 02-auth-smtp-onboarding
plan: 04
subsystem: app-shell-dashboard
tags: [ui, shell, dashboard, clerk, sidebar, soft-gate]
requires:
  - "lib/config.ts HIRE_ME_URL (02-01)"
  - "lib/data/smtp.ts getSmtpConfigForUser + toSmtpConfigDto (02-03)"
  - "components/ui/sidebar|card|badge|button|separator (02-01)"
  - "app/layout.tsx ClerkProvider (02-01)"
  - "proxy.ts auth.protect (02-01)"
provides:
  - "app/(app)/layout.tsx — authenticated shell (sidebar + UserButton + footer) every later phase drops pages into"
  - "components/app-sidebar.tsx — Dashboard + SMTP Settings nav slots"
  - "components/site-footer.tsx — attribution + hire-me funnel link"
  - "app/(app)/dashboard/page.tsx — soft-gate / verified / re-verify states"
  - "--success semantic color token in app/globals.css"
affects:
  - "app/globals.css (added --success token)"
tech-stack:
  added: []
  patterns:
    - "Route-group (app) layout nests inside root layout — ClerkProvider not duplicated"
    - "Server-derived Clerk userId scopes the dashboard config fetch (no client-supplied id)"
    - "Only toSmtpConfigDto fields cross to the client; encrypted triple never referenced"
key-files:
  created:
    - "app/(app)/layout.tsx"
    - "app/(app)/dashboard/page.tsx"
    - "components/app-sidebar.tsx"
    - "components/site-footer.tsx"
  modified:
    - "app/globals.css"
decisions:
  - "Verified badge uses variant=outline + text-success (icon+text only) — success token stays minimal per UI-SPEC Color contract"
  - "Re-verify-required badge is neutral outline (NOT destructive) per D-08 / Copywriting Contract"
  - "Active nav detection via usePathname makes app-sidebar a client component; layout stays an RSC"
metrics:
  duration: 1
  tasks: 2
  files: 5
  completed: 2026-07-11
---

# Phase 2 Plan 04: App Shell + Dashboard Summary

Authenticated shadcn sidebar shell (Dashboard + SMTP Settings nav, Clerk UserButton, attribution footer) and a dashboard whose dominant fresh-account element is the "Set up your SMTP server" soft-gate, reflecting verified / re-verify-required states from the userId-scoped DAL.

## What Was Built

- **`app/(app)/layout.tsx`** — RSC shell: `SidebarProvider` wrapping `AppSidebar` and a `SidebarInset` content column. Top bar carries the sidebar trigger (left) and Clerk `<UserButton />` (top-right); page content sits in a 640px (`max-w-2xl`) container; `<SiteFooter />` renders on every (app) page. Nests inside the root layout, so `ClerkProvider` is not duplicated (D-11/D-12).
- **`components/app-sidebar.tsx`** — client component (needs `usePathname`) with two active nav slots: Dashboard (`LayoutDashboard` → `/dashboard`) and SMTP Settings (`Settings` → `/settings/smtp`). Active item drives shadcn's `isActive` accent indicator. Commented placeholder marks where future Campaigns/History slots drop in (D-11).
- **`components/site-footer.tsx`** — "Built by Robin Darlington · Hire me for custom tools", the link `href={HIRE_ME_URL}` from `@/lib/config` (D-12). Label-size muted text, sentence case, no exclamation marks.
- **`app/(app)/dashboard/page.tsx`** — RSC that fetches `getSmtpConfigForUser(await auth().userId)` and renders three states: (1) no config → dominant `Card` callout "Connect your email server" + primary "Set up your SMTP server" CTA; (2) config with `verified_at` set → summary card (host:port, from line) + "Verified" badge (`CheckCircle2`, success token) + outline "Edit SMTP settings"; (3) `verified_at === null` → same summary card + neutral outline "Re-verify required" badge + "Re-verify connection" CTA back into the wizard.
- **`app/globals.css`** — added the `--success` semantic token to `:root`, `.dark`, and `@theme inline` (`--color-success`), used only for the Verified badge icon+text.

## Acceptance Criteria

- [x] Signed in, `/dashboard` renders the sidebar shell with a UserButton and footer.
- [x] No config → the "Set up your SMTP server" callout is the dominant element.
- [x] Verified config → summary card + "Verified" badge; cleared `verified_at` → "Re-verify required" badge.
- [x] `npx --no-install tsc --noEmit` exits 0.
- [x] Grep gate: no `password_enc|password_iv|password_tag` under `app/(app)` (0 matches).

## Security (threat model)

- **T-2-IDOR** — dashboard fetches via `getSmtpConfigForUser(userId)` where `userId` comes from `await auth()` (server-derived), never a client param.
- **T-2-CRED** — only `toSmtpConfigDto` fields are read; the encrypted password triple is never referenced in the RSC, confirmed by the grep gate.

## Deviations from Plan

None — plan executed as written. The `--success` token addition was anticipated by the plan (Task 2 "add to globals.css only if the badge needs it"); the Verified badge needs it, so it was added.

## Known Stubs

None. `/settings/smtp` (the CTA target) is built by a sibling plan in this phase; the links are intentionally live and will resolve once that route lands.

## Verification Status

Automated gates passed (`tsc --noEmit` clean, copy/artifact greps pass, security grep gate = 0). Task 3 is a human-verify checkpoint (`npm run dev` + sign in, visual check of shell/nav/footer/soft-gate) — pending human sign-off; cannot be automated (browser + Clerk session required).

## Self-Check: PASSED

- FOUND: app/(app)/layout.tsx
- FOUND: app/(app)/dashboard/page.tsx
- FOUND: components/app-sidebar.tsx
- FOUND: components/site-footer.tsx
- FOUND commit 4ab0d2b (shell), 1416ce2 (dashboard)
