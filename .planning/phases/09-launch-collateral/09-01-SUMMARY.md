---
phase: 09-launch-collateral
plan: 01
subsystem: public-marketing-surface
tags: [routing, clerk, marketing, footer, brand-01]
requires:
  - "components/site-footer.tsx (existing, reused unchanged)"
  - "lib/config.ts HIRE_ME_URL constant (existing)"
  - "proxy.ts clerkMiddleware allowlist (existing)"
  - "components/ui: Button, Card, Separator (installed)"
provides:
  - "Public marketing shell: app/(marketing)/layout.tsx (header + main + SiteFooter)"
  - "Session-aware landing at / (app/(marketing)/page.tsx)"
  - "Footer coverage on /sign-in and /sign-up (app/sign-in/layout.tsx, app/sign-up/layout.tsx)"
  - "Four anchored public routes in PUBLIC_PATHS (/, /docs, /self-host, /agents)"
  - "Live BRAND-01 hire-me URL"
affects:
  - "proxy.ts route protection allowlist"
  - "/ route (now a public landing instead of a redirect)"
tech-stack:
  added: []
  patterns:
    - "Route groups are URL-transparent: app/(marketing)/page.tsx serves /"
    - "Server-side auth() gate before render to avoid landing flash"
    - "Anchored regex allowlist entries as a route-protection control (T-09-01)"
    - "Per-route layout.tsx to inject SiteFooter on routes outside layout groups (SC4)"
key-files:
  created:
    - "app/(marketing)/layout.tsx"
    - "app/(marketing)/page.tsx"
    - "app/sign-in/layout.tsx"
    - "app/sign-up/layout.tsx"
  modified:
    - "proxy.ts"
    - "lib/config.ts"
  deleted:
    - "app/page.tsx"
key-decisions:
  - "Two accent Get started CTAs (hero + foot) are the same single action — allowed by UI-SPEC one-accent discipline"
  - "Hero headline scales sm:text-4xl lg:text-5xl with base 28px Display preserved (D-3)"
requirements-completed: [BRAND-01]
duration: 2 min
completed: 2026-07-18
---

# Phase 09 Plan 01: Public Marketing Surface Walking Skeleton Summary

Delivered the first end-to-end public slice: a signed-out visitor reaches `/` and sees the niche-framed landing inside a public marketing shell whose footer carries the live `https://robindarlington.com/contact/` attribution link (BRAND-01); a signed-in visitor is redirected server-side to `/dashboard` with no flash. Opened exactly four anchored public routes in the Clerk allowlist and closed the SC4 footer gap by rendering `SiteFooter` on `/sign-in` and `/sign-up`.

- **Duration:** ~2 min (start 2026-07-18T22:33:45Z, end 2026-07-18T22:36:12Z)
- **Tasks:** 2 / 2
- **Files:** 4 created, 2 modified, 1 deleted

## What was built

### Task 1 — Open four public routes + flip hire-me URL (BRAND-01) — commit 650f9e4
- Extended `proxy.ts` `PUBLIC_PATHS` to six anchored regexes in order: `/^\/$/`, `/^\/docs(\/.*)?$/`, `/^\/self-host(\/.*)?$/`, `/^\/agents(\/.*)?$/`, plus the existing sign-in/up entries. The `clerkMiddleware` body and `config.matcher` were left byte-for-byte unchanged. Every new entry is anchored `^…$` — the T-09-01 route-protection control against a too-broad match like `/dashboard/docs`.
- Flipped `lib/config.ts` `HIRE_ME_URL` from `https://example.com/hire-me` to `https://robindarlington.com/contact/` and rewrote the adjacent comment to describe it as the live BRAND-01 destination (no longer a placeholder). `components/site-footer.tsx` reads the constant and needed no edit.
- No `middleware.ts` created (silently ignored in Next 16).

### Task 2 — Marketing shell + landing + auth-route footer (SC4) — commit 9436c48
- `app/(marketing)/layout.tsx`: `flex min-h-svh flex-col` column with an `h-16 border-b` header (wordmark `Link` → `/` + `variant="outline"` Sign in button, neutral per D-4), `<main className="flex-1">`, and `SiteFooter` beneath. No second ClerkProvider; footer is not added to root layout (would double-render on authed pages).
- `app/(marketing)/page.tsx`: async RSC serving `/`. Opens with `const { userId } = await auth(); if (userId) redirect("/dashboard");` (server-side gate, no flash). Landing uses the exact UI-SPEC Landing copy — Display hero (`text-[28px] font-semibold leading-[1.2]` with `sm:`/`lg:` scale-up), subhead, single accent `Get started` CTA → `/sign-up`, neutral `See the docs` link, a `Built for two jobs` two-card section, a `What you get` feature list with decorative `text-muted-foreground` lucide icons, the muted trust line, and a repeated foot `Get started` CTA. Containers `max-w-5xl` (hero/grid) / `max-w-3xl` (prose), `mx-auto px-6`. Image-light (no `public/` dependency).
- `app/sign-in/layout.tsx` + `app/sign-up/layout.tsx`: minimal server layouts each wrapping `{children}` in a `flex min-h-svh flex-col` column with `SiteFooter` beneath, so the attribution footer appears on the auth routes that sit outside both layout groups (SC4). The existing `[[...sign-in]]`/`[[...sign-up]]` catch-all pages were not modified.
- Deleted `app/page.tsx` (its unconditional `redirect("/dashboard")` is replaced by the session-aware landing; leaving it would collide on `/`). This deletion is intentional.

## Deviations from Plan

None - plan executed exactly as written.

## Authentication Gates

None encountered — no `npm install`, deploy, or login step was required.

## Verification results

- `npm run build` green after both tasks (primary phase gate).
- Task 1 gate `GATE_PASS`: four new anchored regexes present, `robindarlington.com/contact/` present, `example.com/hire-me` removed, no `middleware.ts`.
- Task 2 gate `GATE_PASS`: `await auth()` + `redirect("/dashboard")` + exact hero copy present in landing; `SiteFooter` present in `(marketing)/layout.tsx`, `sign-in/layout.tsx`, `sign-up/layout.tsx`; `app/page.tsx` removed; `/` resolves as a single dynamic route.
- One-accent discipline: header Sign in is `variant="outline"`; the two `<Button asChild>` accent instances are both the same `Get started` → `/sign-up` action (hero + foot repeat, explicitly permitted by UI-SPEC).
- Full route-reachability (all four public routes 200, authed routes still protected) is asserted by the Plan 03 route-probe smoke once the remaining marketing pages exist.

## Known Stubs

None. Note: `/docs`, `/self-host`, and `/agents` are now allowlisted but their page files are delivered by Plan 02 — until then those paths render Next.js 404s (public, not authed-protected), which is the intended wave sequencing, not a stub in this plan's surface.

## Next steps

Ready for 09-02 (content pages: `/docs`, `/self-host`, `/agents`).

## Self-Check: PASSED
- app/(marketing)/layout.tsx — FOUND
- app/(marketing)/page.tsx — FOUND
- app/sign-in/layout.tsx — FOUND
- app/sign-up/layout.tsx — FOUND
- proxy.ts, lib/config.ts — modified, FOUND
- app/page.tsx — removed as intended
- commit 650f9e4 — FOUND
- commit 9436c48 — FOUND
