# Phase 9: Launch Collateral - Research

**Researched:** 2026-07-19
**Domain:** Next.js 16 public/marketing routes + Clerk route exposure, repo packaging (README/write-up), site-wide footer attribution, Coolify staging deploy
**Confidence:** HIGH (all findings verified against the live codebase; no new external packages)

## Summary

Phase 9 is a **packaging + presentation** phase, not a feature build. It adds four signed-out public routes inside the *existing* Next.js 16 app (`/` landing, `/docs`, `/self-host`, `/agents`), a root `README.md`, a `docs/writeup.md` draft, and makes the already-existing attribution footer render on public pages too — then deploys the slice to Coolify staging. There are **no new runtime dependencies** (locked in CONTEXT) and the work is almost entirely additive React/Tailwind/shadcn pages plus Markdown files.

The single most important technical fact: **route protection lives in `proxy.ts`** (Next.js 16 renamed `middleware.ts` → `proxy.ts`; a `middleware.ts` file is silently ignored). It currently uses a `PUBLIC_PATHS` regex allowlist and calls `auth.protect()` on everything else. Making the four routes public is a **one-array edit** to that allowlist. The landing route (`app/page.tsx`) currently hard-redirects to `/dashboard`; it must become a signed-in check (`auth()` → redirect to `/dashboard` when a session exists, otherwise render the landing). The footer component (`components/site-footer.tsx`) and its `HIRE_ME_URL` constant (`lib/config.ts`) already exist but are only wired into the `(app)` layout — public pages need their own layout that also renders it, and `HIRE_ME_URL` must be flipped from the `example.com` placeholder to `https://robindarlington.com/contact/` (BRAND-01).

Screenshots are the one genuinely awkward part: the repo has **no Playwright / browser tooling and no `public/` dir**. Public pages can be captured with any headless browser without a session; authed screens require a Clerk session (Clerk *test mode* with `+clerk_test` emails and OTP `424242` makes this possible in a dev instance, but it is fiddly). The pragmatic plan is to capture the public landing + whatever authed screens are attainable and queue a "replace/add authed screenshots" checkpoint for Rob.

**Primary recommendation:** Add a `(marketing)` route group with its own layout (header + `SiteFooter`), convert `app/page.tsx` to a session-aware landing, extend `PUBLIC_PATHS` in `proxy.ts` with four regexes, flip `HIRE_ME_URL`, mirror `packages/cli/README.md` verbatim into `/agents`, mirror `.env.example` self-host vars into `/self-host`, write `README.md` + `docs/writeup.md`, capture public-page screenshots into `docs/screenshots/`, then push to trigger the Coolify compose deploy and human-verify the staging URL.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Public routing (LOCKED 2026-07-15):** Same Next.js app, not a separate site. Clerk middleware (`proxy.ts`) makes `/`, `/docs`, `/self-host`, `/agents` public (signed-out accessible). Signed-in users hitting `/` land on the dashboard (redirect in the landing route or middleware).
- Landing copy frames the two core niches: **credential delivery**, and **per-row documents** (payslips, certificates, invoices). Honest, plain-spoken, portfolio-grade — no marketing fluff, no fabricated testimonials/metrics.
- **README (auto-decided):** Root `README.md` — what it is, screenshot(s), the two niches, feature list, quickstart (local dev), self-host pointer (links `/self-host` and docs), CLI/MCP pointer (links `packages/cli` README + `/agents`), license (MIT), attribution + hire-me link. Links the public repo `https://github.com/robindarlington/mail-merge`.
- **Screenshots (auto-decided):** captured against the local dev server via browser automation where possible (public landing + key authed screens if a dev session is attainable without interactive login; otherwise capture what is accessible and queue a "replace/add authed screenshots" item for Rob). Stored under `docs/screenshots/`, referenced with relative paths so they render on GitHub.
- **Write-up (auto-decided):** `docs/writeup.md` draft for robindarlington.com/thoughts/ — the story of generalizing a one-off credential-delivery CLI into a self-serve product; architecture choices (Next.js + SQLite + worker on Coolify, BYO SMTP); the spec-driven AI-assisted build process. Publishable with light editing; Rob publishes manually.
- **Footer (BRAND-01, auto-decided):** One shared footer component on all pages (public routes AND authed app pages, via root layout): "Built by Robin Darlington" + link to `https://robindarlington.com/contact/` ("Hire me for custom work" or similar). Unobtrusive, consistent with existing UI (Tailwind + shadcn tokens).
- **Deploy (auto-decided):** Staging deploys from GitHub push via Coolify (compose build pack). Push after completion; verifying public routes on the standing staging URL is the human-verifiable checkpoint at phase end.

### Claude's Discretion
Copy tone, page structure, screenshot selection, and component layout per existing conventions and the frontend-design skill. **No new runtime dependencies.**

### Deferred Ideas (OUT OF SCOPE)
SEO/OG tooling beyond basic metadata, analytics, blog infra, pricing pages, publishing automation for the write-up, demo-video/GIF production (nice-to-have if time allows; not a success criterion). Also out of scope (from CONTEXT domain): SEO tooling, separate marketing site, paid-tier/pricing pages, publishing the write-up.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BRAND-01 | The app UI displays attribution to Robin Darlington with a visible "hire me for tech support / custom work" link (footer or equivalent) | Footer component `components/site-footer.tsx` + `HIRE_ME_URL` in `lib/config.ts` already exist and render in the `(app)` layout. This phase (a) flips `HIRE_ME_URL` from the `example.com` placeholder to `https://robindarlington.com/contact/`, and (b) ensures the footer renders on the **public** routes too (a new marketing layout, or promotion to root layout). REQUIREMENTS.md already marks BRAND-01 "Complete" for the authed surface — Phase 9 completes it across public pages and sets the live URL. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Public route exposure (allowlist) | Frontend Server (`proxy.ts` edge middleware) | — | Clerk `clerkMiddleware` decides signed-in vs. signed-out per request before the route renders |
| Signed-in redirect off `/` | Frontend Server (RSC `app/page.tsx`, `auth()`) | Proxy | The landing is public; only a *server-side* session check can redirect an authed user to `/dashboard` without flashing the landing |
| Landing / docs / self-host / agents content | Frontend Server (RSC pages) | — | Static/SSR marketing content; no client interactivity required beyond links |
| Footer attribution (BRAND-01) | Frontend Server (shared React component in a layout) | — | Must render identically on public and authed pages; layout-level placement |
| README / write-up | Repo artifacts (Markdown) | — | GitHub-rendered docs; not part of the running app |
| Screenshots | Build/tooling (headless browser against dev server) | Human (authed captures) | Public pages capturable headlessly; authed captures need a Clerk session |
| Staging deploy | CDN/Platform (Coolify compose on VPS) | — | Push-to-deploy; the app image/compose is unchanged by this phase |

## Standard Stack

**No new packages.** Everything needed is already installed and in use. This section documents the *existing* stack the phase builds on.

### Core (already present — verified in `package.json` + `node_modules`)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | 16.2.9 | App Router, RSC pages, `proxy.ts` middleware, `output: standalone` | The app framework; public routes are just more App Router pages |
| @clerk/nextjs | 7.5.9 | `clerkMiddleware` / `auth.protect()` / `auth()` for route protection + session checks | Already the auth layer; public-route allowlist is a Clerk config edit |
| react / react-dom | 19.2 | RSC + components | — |
| tailwindcss | 4.3 (CSS-first, `app/globals.css`) | Styling; oklch token system already defined | Landing/docs pages reuse existing tokens — no new palette |
| shadcn primitives | radix-nova / neutral (components.json) | `Button`, `Card`, `Separator`, `Badge`, etc. under `components/ui/` | Reuse for marketing pages; consistent look |
| lucide-react | 1.21.0 | Icons | Already the icon lib |
| next/font (Geist) | — | `--font-sans` wired in root layout | Keep — do NOT introduce a display font per frontend-design without checking; see Pitfall 5 |

### Supporting (for screenshots — OPTIONAL, and constrained by "no new runtime deps")
| Approach | Purpose | When to Use |
|----------|---------|-------------|
| Orchestrator's browser/Chrome tools (if available to the executor) | Capture public + authed pages against `next dev` | Preferred: no dependency added |
| Manual capture by Rob | Authed screens behind interactive Clerk login | Fallback; queue as a checkpoint |
| Playwright as a **devDependency** | Scripted headless capture | ONLY if the executor has no browser tooling AND treats it as a dev-only dep — note CONTEXT says "no new runtime dependencies"; a devDep for one-time capture is a judgment call, lean toward avoiding it |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Route group `(marketing)` with own layout | Put footer in **root** layout, remove from `(app)` layout | Root-layout footer is fewer files but risks double-footer if not also removed from `(app)`; a `(marketing)` group is cleaner and lower-risk (see Pattern 2) |
| MDX for `/docs` | Plain TSX pages with prose | MDX = new dependency (`@next/mdx`), forbidden by CONTEXT. Use TSX prose. |
| Separate marketing site | Same app (LOCKED) | Locked — same app only |

**Installation:** None. `npm install` adds nothing this phase.

## Package Legitimacy Audit

**Not applicable.** This phase installs **zero** external packages (CONTEXT: "No new runtime dependencies"). The only *possible* optional install is Playwright as a devDependency for screenshots, which the research recommends **against** in favor of existing browser tooling or manual capture. If the planner elects to add Playwright anyway, gate it behind a `checkpoint:human-verify` task and run the Package Legitimacy Gate at that point. `[VERIFIED: package.json + node_modules]`

## Architecture Patterns

### System Architecture Diagram

```
                        HTTP request
                             │
                             ▼
                   ┌───────────────────┐
                   │    proxy.ts       │  Clerk clerkMiddleware
                   │ (edge middleware) │  matches PUBLIC_PATHS?
                   └─────────┬─────────┘
                  public ◄───┴───► not public
                     │               │
                     │               ▼  auth.protect() → /sign-in
                     ▼
         ┌───────────────────────────┐
         │  Is this the `/` landing? │
         └────────┬──────────┬───────┘
            no    │          │  yes → app/page.tsx (RSC)
                  │          │        auth(): userId?
                  ▼          │          ├─ yes → redirect /dashboard
        /docs /self-host     │          └─ no  → render Landing
        /agents (RSC pages)  │
                  │          │
                  └────┬─────┘
                       ▼
            ┌────────────────────┐
            │ (marketing) layout │  header (logo + Sign in) + children + SiteFooter
            └─────────┬──────────┘
                      ▼
                 SiteFooter  ← same component the (app) layout uses
                 HIRE_ME_URL = https://robindarlington.com/contact/
```

Signed-in users retain the `(app)` route group (sidebar shell + `SiteFooter`), unchanged. Public visitors get the `(marketing)` shell. The `(app)` and `(marketing)` groups both nest under the single root layout (`ClerkProvider`).

### Recommended Project Structure
```
app/
├── layout.tsx                 # root — ClerkProvider (unchanged)
├── page.tsx                   # `/` landing — CONVERT: auth() gate + Landing render
├── (marketing)/               # NEW route group — public shell (header + SiteFooter)
│   ├── layout.tsx             # NEW — marketing layout with footer
│   ├── docs/page.tsx          # NEW — /docs
│   ├── self-host/page.tsx     # NEW — /self-host (env vars incl. CREDENTIAL_ENC_KEY, Clerk keys)
│   └── agents/page.tsx        # NEW — /agents (mirrors packages/cli/README.md)
├── (app)/…                    # unchanged authed shell (already renders SiteFooter)
├── sign-in / sign-up          # unchanged
proxy.ts                       # EDIT — add 4 regexes to PUBLIC_PATHS
lib/config.ts                  # EDIT — flip HIRE_ME_URL
components/site-footer.tsx     # reuse (may relocate marketing/authed as needed)
docs/
├── writeup.md                 # NEW — "how it was built" draft
└── screenshots/               # NEW — README images (relative paths)
README.md                      # NEW — repo root
```

Note: `app/page.tsx` sits **outside** the `(marketing)` group, so if you want the landing to share the marketing header/footer you either (a) move it to `app/(marketing)/page.tsx` (route group is URL-transparent, `/` still works), or (b) render `<SiteFooter/>` directly in it. Option (a) is cleaner — a route group does not change the URL, so `app/(marketing)/page.tsx` still serves `/`.

### Pattern 1: Public-route allowlist in Clerk middleware (Next.js 16 `proxy.ts`)
**What:** Extend the existing `PUBLIC_PATHS` regex array so the four routes bypass `auth.protect()`.
**When to use:** This is the locked mechanism for signed-out access.
**Example:**
```typescript
// Source: existing /Users/rob/Desktop/projects/Apps/mail-merge/proxy.ts (verified in-repo)
const PUBLIC_PATHS = [
  /^\/$/,                       // landing
  /^\/docs(\/.*)?$/,           // docs
  /^\/self-host(\/.*)?$/,      // self-host
  /^\/agents(\/.*)?$/,         // agents
  /^\/sign-in(\/.*)?$/,        // (existing)
  /^\/sign-up(\/.*)?$/,        // (existing)
];
// clerkMiddleware body is unchanged: if (!isPublic) await auth.protect();
```
`[VERIFIED: proxy.ts]` — the file already implements this allowlist pattern; only the array changes.

### Pattern 2: Session-aware landing (redirect signed-in users to /dashboard)
**What:** Replace the unconditional `redirect('/dashboard')` with a session check.
**When to use:** The `/` route (LOCKED: signed-in users land on dashboard).
**Example:**
```typescript
// Source: Clerk v7 server auth() — CITED clerk.com/docs + verified pattern in app/(app)/dashboard/page.tsx
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");
  return <Landing />; // niche-framed marketing content
}
```
`[VERIFIED: codebase]` — `app/(app)/dashboard/page.tsx` already uses `const { userId } = await auth()` this exact way. `[CITED: clerk.com/docs/references/nextjs/auth]`

### Pattern 3: Footer on public pages without double-rendering on authed pages
**What:** The `(app)` layout already renders `<SiteFooter/>`. Give the `(marketing)` group its own layout that renders it too. Do NOT also add it to the root layout (that would double it on authed pages).
**Example:**
```tsx
// app/(marketing)/layout.tsx (NEW)
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { Button } from "@/components/ui/button";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b px-6">
        <Link href="/" className="text-xl font-semibold">Mail Merge</Link>
        <Button asChild variant="outline"><Link href="/sign-in">Sign in</Link></Button>
      </header>
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
```

### Pattern 4: `/agents` mirrors `packages/cli/README.md` verbatim
**What:** The `/agents` page's copy-paste blocks (npx commands, the MCP `mcpServers` JSON snippet) must match `packages/cli/README.md` **exactly** (CONTEXT specifics). Render them in `<pre>`/code blocks. The canonical MCP snippet is:
```json
{ "mcpServers": { "mail-merge": { "command": "npx", "args": ["-y", "@robindarlington/mail-merge", "mcp"] } } }
```
and the canonical npx invocation is `npx @robindarlington/mail-merge --csv data.csv --template msg.txt` (dry-run default). `[VERIFIED: packages/cli/README.md]`

### Anti-Patterns to Avoid
- **Creating `middleware.ts`:** Silently ignored in Next.js 16 — protection must stay in `proxy.ts`.
- **Adding the footer to the root layout AND leaving it in `(app)`:** double footer on authed pages.
- **Introducing MDX / a marketing CSS framework / a display font package:** violates "no new runtime dependencies."
- **Hardcoding the CLI examples on `/agents` by paraphrase:** they must be verbatim copies of the README so they actually work.
- **Prerendering a page that calls `auth()`:** those pages are dynamic by design; do not force static export.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Route protection / public allowlist | Custom cookie/session checks | Existing `clerkMiddleware` allowlist in `proxy.ts` | Clerk already owns auth; hand-rolled checks bypass session handshake |
| Attribution footer | A second footer component | Existing `components/site-footer.tsx` + `HIRE_ME_URL` | Already built, themed, and BRAND-01-compliant |
| Marketing page styling | New CSS / a UI kit | Existing shadcn primitives + `app/globals.css` oklch tokens | Consistency + zero new deps |
| Env-var docs on `/self-host` | Freehand list | Mirror `.env.example` (the "COMPLETE contract" per its own header) | `.env.example` is authoritative and already documents Coolify build-vs-runtime nuance |

**Key insight:** Almost every "component" this phase needs already exists in the repo — the work is *composition and copy*, not construction.

## Runtime State Inventory

This is a rename-adjacent change only in one spot: **`HIRE_ME_URL`**. It is a code constant, not stored/registered runtime state.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no DB rows reference marketing content or the hire-me URL. Verified: `HIRE_ME_URL` is a TS constant in `lib/config.ts`, not persisted. | None |
| Live service config | None — Coolify deploy config unchanged; no new env vars introduced by the marketing pages themselves. `/self-host` merely *documents* existing vars. | None |
| OS-registered state | None — no scheduled tasks, no process names change. | None |
| Secrets/env vars | `CREDENTIAL_ENC_KEY`, `NEXT_PUBLIC_CLERK_*` are **documented** on `/self-host` and in the README (self-host section), not renamed or added. `.env.example` is the source of truth to mirror. | None (doc-only reference) |
| Build artifacts | None — no package renames; `output: standalone` build is unaffected by additive pages. Screenshots go in `docs/screenshots/` (repo), not `public/`. | Rebuild via normal Coolify deploy |

**Nothing found requiring a data migration.** The only "flip" is `HIRE_ME_URL` (`example.com/hire-me` → `https://robindarlington.com/contact/`), a single-value code edit by design (`lib/config.ts` comment: "BRAND-01 in Phase 9 flips this single placeholder value").

## Common Pitfalls

### Pitfall 1: Editing `middleware.ts` instead of `proxy.ts`
**What goes wrong:** Routes stay protected (or unprotected) with no error.
**Why it happens:** Next.js 16 renamed the convention; muscle memory / stale docs say `middleware.ts`.
**How to avoid:** All route-protection edits go in the existing root `proxy.ts`. The file's own header comment documents this.
**Warning signs:** Public routes still redirect to `/sign-in` after "fixing" middleware.

### Pitfall 2: Landing flashes before redirecting signed-in users
**What goes wrong:** An authed user briefly sees the marketing page before `/dashboard`.
**Why it happens:** Doing the redirect client-side instead of in the RSC.
**How to avoid:** Do the `auth()` check server-side in `app/page.tsx` (or `app/(marketing)/page.tsx`) and `redirect()` before returning JSX — no flash.
**Warning signs:** A visible flicker on login → dashboard.

### Pitfall 3: `HIRE_ME_URL` left at the placeholder
**What goes wrong:** BRAND-01 "hire me" link points at `example.com/hire-me` in production.
**Why it happens:** Easy to forget the one-line flip in `lib/config.ts`.
**How to avoid:** Make flipping `HIRE_ME_URL` to `https://robindarlington.com/contact/` an explicit task; the footer, README, and CLI author section should all point to real destinations.
**Warning signs:** Footer link 404s / hits example.com.

### Pitfall 4: `/agents` (or README) examples drift from the CLI README
**What goes wrong:** Copy-paste MCP config or npx command on `/agents` doesn't match the published package, so it fails for users.
**Why it happens:** Paraphrasing instead of copying `packages/cli/README.md`.
**How to avoid:** Copy the code blocks verbatim; add a verification step diffing the snippets against `packages/cli/README.md`.
**Warning signs:** Package name, flags, or the `-y` in `npx -y` differ.

### Pitfall 5: frontend-design skill vs. the locked design system
**What goes wrong:** The frontend-design skill pushes "bold/distinctive fonts, dramatic aesthetics"; blindly applying it would break the app's established radix-nova/neutral/oklch system and introduce a font dependency.
**Why it happens:** The skill is written for greenfield artifacts; this app has a mature, inherited UI-SPEC (Geist, 4 sizes / 2 weights, neutral oklch, one-accent discipline).
**How to avoid:** Treat the marketing pages as members of the **existing** design system. Use Geist, the existing tokens, sentence-case copy, no exclamation marks (Copywriting Contract), and reuse shadcn primitives. Distinctiveness comes from layout/copy, not new fonts/palettes. **No new font packages** (that would be a new dependency anyway).
**Warning signs:** A Google Font import appears; purple gradients; a second type scale.

### Pitfall 6: Screenshots referenced from `public/` that doesn't exist / broken GitHub paths
**What goes wrong:** README images don't render on GitHub, or the landing references a missing `/public` asset.
**Why it happens:** No `public/` dir exists; README needs *relative* paths, landing needs `public/`.
**How to avoid:** Put README screenshots in `docs/screenshots/` and reference them with **relative** Markdown paths (`![...](docs/screenshots/x.png)`). If the *landing page* shows an image, create `public/` and reference `/x.png`. Keep landing image-light to avoid the `public/` requirement if browser tooling is unavailable.
**Warning signs:** Broken image icons in the GitHub README preview.

### Pitfall 7: Coolify compose build pack requirement (repo memory)
**What goes wrong:** A Dockerfile-build-pack deploy silently drops the worker + compose env.
**Why it happens:** Documented in repo memory (2026-07-18): staging is a **Docker Compose** build-pack app since 2026-07-18; a plain Dockerfile build pack breaks it.
**How to avoid:** Do not change the build pack. Just push to GitHub; Coolify redeploys from `docker-compose.yml`. The marketing pages are inside the same Next.js image — no compose change needed.
**Warning signs:** Worker missing / env vars unset after deploy.

## Code Examples

### `/self-host` env-var table (mirror `.env.example`)
```tsx
// Source: /Users/rob/Desktop/projects/Apps/mail-merge/.env.example (authoritative "COMPLETE contract")
// Key vars to document (do not invent — copy names/semantics from .env.example):
//  DATABASE_PATH (/data/app.db in prod)         — runtime
//  UPLOADS_PATH (/data/uploads in prod)          — runtime
//  CREDENTIAL_ENC_KEY (openssl rand -base64 32)  — RUNTIME SECRET, 32 bytes, fails closed
//  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY             — BUILD-TIME (inlined by next build; Coolify build var)
//  NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in etc.   — BUILD-TIME
//  CLERK secret key                              — RUNTIME SECRET (never a build arg)
// Emphasize the build-vs-runtime split — .env.example calls this out explicitly.
```

### README skeleton (satisfies success criterion #1)
```markdown
# Mail Merge  ·  https://github.com/robindarlington/mail-merge
CSV-driven, plain-text mail merge over your own SMTP.
![Landing](docs/screenshots/landing.png)      <!-- ≥1 screenshot, relative path -->
## Who it's for  — credential delivery · per-row documents (payslips/certificates/invoices)
## Features …
## Quickstart (local dev)  — node >=24; npm install; set .env (see .env.example); npm run dev
## Self-host  — see /self-host and docs/  (Docker/Coolify, CREDENTIAL_ENC_KEY, Clerk keys)
## CLI & MCP for agents  — see packages/cli/README.md and /agents
## License — MIT
## Author — Built by Robin Darlington · Hire me: https://robindarlington.com/contact/
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `middleware.ts` convention | `proxy.ts` convention | Next.js 16 | Route protection MUST live in `proxy.ts` (already done in this repo) |
| Route-matcher `createRouteMatcher` for authz | Resource-based checks in data layer; middleware only answers "signed in?" | Clerk v7 | Don't reintroduce the removed matcher helper (proxy.ts comment) |

**Deprecated/outdated:** `createRouteMatcher`-based fine-grained authz (removed in Clerk v7); `middleware.ts` (ignored in Next 16).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Screenshots will be captured via the orchestrator's browser tooling or manually by Rob (no Playwright dependency added) | Standard Stack / Validation | Low — if no tooling is available, authed screenshots get queued for Rob; public ones may still need a manual capture |
| A2 | A `(marketing)` route group with `app/(marketing)/page.tsx` serving `/` is acceptable (route groups are URL-transparent) | Architecture Patterns | Low — falls back to keeping `app/page.tsx` and rendering `<SiteFooter/>` inline |
| A3 | Landing may be kept image-light so a `public/` dir is not strictly required for the app itself | Pitfalls | Low — creating `public/` is trivial if a hero image is wanted |
| A4 | Coolify staging URL already exists and only needs a push to redeploy (per prior phases + repo memory) | Deploy / Validation | Medium — if the staging app isn't provisioned, the human-verify checkpoint surfaces it |
| A5 | Marketing pages adopt the existing design system rather than the frontend-design skill's "bold new aesthetic" | Pitfalls | Low — consistent with every prior UI-SPEC; reversible copy/layout choices |

**Note:** No `[ASSUMED]` package or compliance claims — the phase adds no packages and no security-sensitive behavior.

## Open Questions

1. **Authed-screen screenshots without interactive Clerk login**
   - What we know: Clerk *test mode* allows `+clerk_test` emails with OTP `424242` in a **development** instance, enabling scripted sign-in; the repo has no browser-automation tooling installed.
   - What's unclear: Whether the executor has access to browser/Chrome tools at run time, and whether the dev Clerk instance is in test mode.
   - Recommendation: Capture public pages first (no session needed). Attempt authed capture only if browser tooling + a test-mode Clerk dev instance are available; otherwise queue a "Rob captures authed screens" checkpoint. Do not add Playwright just for this.

2. **Landing hero image → `public/` dir**
   - What we know: No `public/` dir exists; README images live in `docs/screenshots/`.
   - What's unclear: Whether the landing design wants an in-page screenshot (needs `public/`) or stays copy/diagram-only.
   - Recommendation: Prefer copy + a simple in-page architecture blurb; create `public/` only if a hero image is chosen.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | dev server, build | ✓ | 24.9.0 (host) / pinned >=24 | — |
| Next.js dev/build | render + screenshot pages | ✓ | 16.2.9 | — |
| Clerk dev instance | authed screenshots / local auth | ✓ (keys in `.env`) | @clerk/nextjs 7.5.9 | Public-page-only screenshots |
| Headless browser / Playwright | scripted screenshots | ✗ (not installed; no `public/`, no Playwright) | — | Orchestrator browser tools, or manual capture by Rob |
| Coolify staging (VPS) | success criterion #5 deploy | ✓ (per prior phases + repo memory) | compose build pack | Human-verify checkpoint if not provisioned |
| git / GitHub push | triggers Coolify deploy | ✓ | — | — |

**Missing dependencies with no fallback:** None block the core work (routes, README, write-up, footer, deploy).
**Missing dependencies with fallback:** Browser automation for screenshots — fall back to orchestrator tools or a Rob checkpoint.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) via `node --import tsx --test "lib/**/*.test.ts"` |
| Config file | none — glob in `package.json` `test` script |
| Quick run command | `npm test` (lib unit tests only) |
| Full suite command | `npm test` + `npm run build` (build is the real gate for pages) |

**Reality:** The existing test suite covers `lib/**` logic only. There are **no** page/component/e2e tests and no test framework for React routes (no Playwright, no Vitest/RTL). Phase 9 produces routes + Markdown, whose correctness is best validated by a successful production build, route-accessibility checks, and the staging human-verify — not by unit tests. Adding an e2e framework would violate "no new runtime dependencies" and is out of scope.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRAND-01 | Footer with attribution + live hire-me URL renders on public AND authed pages | build + grep | `npm run build` && `grep -r "robindarlington.com/contact" app components lib` | ✅ (build) |
| SC#2 | `/`, `/docs`, `/self-host`, `/agents` reachable signed-out; `/` redirects signed-in → `/dashboard` | route smoke | `npm run build` then curl each route on `next start` for 200 (signed-out) | ❌ Wave 0 (smoke script) |
| SC#1 | README exists at repo root with ≥1 screenshot + repo link | file check | `test -f README.md && grep -q "github.com/robindarlington/mail-merge" README.md && ls docs/screenshots/*.png` | ❌ Wave 0 |
| SC#3 | `docs/writeup.md` committed | file check | `test -f docs/writeup.md` | ❌ Wave 0 |
| SC#4 | Footer on all pages | build + grep | `grep -rl "SiteFooter" app` shows both `(app)` and `(marketing)` layouts | ✅ (existing footer) |
| SC#5 | Slice deployed to Coolify staging and works | manual | Human-verify checkpoint on staging URL | manual |
| `/agents` parity | npx/MCP snippets match `packages/cli/README.md` | diff | Compare code blocks against `packages/cli/README.md` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run build` (catches broken routes/imports/TS immediately — the primary gate for this phase)
- **Per wave merge:** `npm test` + `npm run build`
- **Phase gate:** Full build green + all file checks pass + staging human-verify before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `scripts/smoke-public-routes.mjs` (or inline curl loop) — asserts 200 for the four public routes on `next start`, and 307/redirect for `/` when a session cookie is present *(optional; build + manual may suffice for MVP)*
- [ ] File-existence assertions for `README.md`, `docs/writeup.md`, `docs/screenshots/*` — trivial shell, can live in the verification step rather than a test file
- [ ] `/agents` snippet-parity check against `packages/cli/README.md`
- [ ] No framework install needed — do NOT add Playwright/Vitest (out of scope)

*(If the planner prefers zero new scripts: rely on `npm run build` + the phase-end human-verify on staging. That is an acceptable MVP validation posture given the phase is docs/pages with no business logic.)*

## Security Domain

`security_enforcement` is enabled (default). This phase is low-risk but has three real security touchpoints:

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Clerk `clerkMiddleware`; do not weaken `auth.protect()` — only the four named routes become public |
| V3 Session Management | yes | `auth()` server-side session check for the `/` redirect; no session handling hand-rolled |
| V4 Access Control | yes | The public allowlist must be **exactly** `/`, `/docs`, `/self-host`, `/agents` (+ existing sign-in/up) — a too-broad regex could expose authed routes |
| V5 Input Validation | no | Marketing pages take no user input |
| V6 Cryptography | no | No crypto here; `/self-host` only *documents* `CREDENTIAL_ENC_KEY` (never prints a real key) |

### Known Threat Patterns for this change
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Over-broad public regex accidentally exposes `/dashboard`, `/settings`, `/api/*` | Elevation of Privilege / Info Disclosure | Anchor regexes (`^\/docs(\/.*)?$` not `\/docs`); keep the allowlist to the four named prefixes; verify authed routes still redirect after the edit |
| Leaking a real `CREDENTIAL_ENC_KEY` or Clerk secret in `/self-host` or README | Information Disclosure | Show only the generator command (`openssl rand -base64 32`) and placeholder names — mirror `.env.example`, which already redacts. Never render a real `.env`. |
| Marketing copy claiming security guarantees the app doesn't have | Repudiation / trust | Keep claims accurate (BYO-SMTP, AES-256-GCM at rest, verify-before-send) — all already true per STATE.md decisions; no fabricated metrics (CONTEXT). |

**Verification step:** After the `proxy.ts` edit, confirm a signed-out request to `/dashboard`, `/settings/smtp`, and an `/api` route still redirects/401s, and the four public routes return 200.

## Sources

### Primary (HIGH confidence — verified in-repo this session)
- `/Users/rob/Desktop/projects/Apps/mail-merge/proxy.ts` — Clerk middleware allowlist pattern, Next 16 proxy convention, Clerk v7 notes
- `app/layout.tsx`, `app/page.tsx`, `app/(app)/layout.tsx`, `app/(app)/dashboard/page.tsx` — layout nesting, `auth()` usage, footer wiring
- `components/site-footer.tsx`, `lib/config.ts` — existing footer + `HIRE_ME_URL` placeholder to flip
- `packages/cli/README.md` — canonical npx + MCP snippets for `/agents`
- `.env.example` — authoritative env-var contract for `/self-host` (build-vs-runtime split, Coolify notes)
- `Dockerfile`, `docker-compose.yml`, `next.config.ts` — standalone output, compose build pack, no build change needed
- `.planning/phases/06-…/06-UI-SPEC.md`, `app/globals.css` — inherited design system (Geist, 4 sizes/2 weights, oklch tokens, sentence-case copy, one-accent discipline)
- `package.json` + `node_modules` — versions: next 16.2.9, @clerk/nextjs 7.5.9, react 19.2; no Playwright/`public/`
- Repo memory (2026-07-18) — Coolify **compose** build pack requirement; push-to-deploy from GitHub

### Secondary (MEDIUM confidence)
- Clerk v7 Next.js docs (`clerk.com/docs/references/nextjs`) — `clerkMiddleware`, `auth()`, `auth.protect()` semantics (corroborated by the in-repo `proxy.ts` comments)

### Tertiary (LOW confidence)
- None — no unverified claims were needed; the phase is fully grounded in the existing codebase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — read directly from `package.json`/`node_modules`; no new deps
- Architecture: HIGH — patterns derived from existing `proxy.ts`, layouts, and dashboard `auth()` usage
- Pitfalls: HIGH — each is grounded in a specific in-repo file, comment, or repo-memory note

**Research date:** 2026-07-19
**Valid until:** 2026-08-18 (stable; the only fast-moving elements — Clerk/Next versions — are pinned in the repo)
