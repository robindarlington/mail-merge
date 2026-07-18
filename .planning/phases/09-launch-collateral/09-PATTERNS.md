# Phase 9: Launch Collateral - Pattern Map

**Mapped:** 2026-07-19
**Files analyzed:** 11 (4 new routes, 1 new layout, 3 edits, 3 repo artifacts)
**Analogs found:** 10 / 11 (README/write-up are Markdown — no code analog, but skeletons exist in RESEARCH.md)

This is a **composition + copy** phase, not a feature build. Almost every building block already exists in the repo. The dominant pattern: new RSC pages reuse the exact heading/spacing/token/Card idioms established in `app/(app)/dashboard/page.tsx` and `app/(app)/settings/smtp/page.tsx`, and reuse `SiteFooter`, `Button`, `Card`, `Separator`, `Badge` unchanged. No new dependencies, no new tokens.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `proxy.ts` (EDIT) | middleware | request-response | `proxy.ts` (self — extend `PUBLIC_PATHS`) | exact (same file) |
| `app/(marketing)/page.tsx` (`/`, converts `app/page.tsx`) | route/page (RSC) | request-response | `app/(app)/dashboard/page.tsx` (`auth()` gate) + `app/page.tsx` (redirect) | exact |
| `app/(marketing)/layout.tsx` (NEW) | layout | request-response | `app/(app)/layout.tsx` (shell + `SiteFooter`) | role-match |
| `app/(marketing)/docs/page.tsx` (NEW) | route/page (RSC) | request-response | `app/(app)/settings/smtp/page.tsx` (heading + prose sections) | role-match |
| `app/(marketing)/self-host/page.tsx` (NEW) | route/page (RSC) | request-response | `app/(app)/dashboard/page.tsx` (Card sections) + `.env.example` (content source) | role-match |
| `app/(marketing)/agents/page.tsx` (NEW) | route/page (RSC) | request-response | `packages/cli/README.md` (verbatim code-block content source) | content-mirror |
| `lib/config.ts` (EDIT `HIRE_ME_URL`) | config | — | `lib/config.ts` (self — single-value flip) | exact (same file) |
| `components/site-footer.tsx` (REUSE) | component | — | `components/site-footer.tsx` (self — no change) | reuse as-is |
| `README.md` (NEW, repo root) | doc (Markdown) | — | `packages/cli/README.md` (structure) + RESEARCH.md skeleton | partial |
| `docs/writeup.md` (NEW) | doc (Markdown) | — | none (new artifact; CONTEXT/RESEARCH provide the brief) | no analog |
| `docs/screenshots/*.png` (NEW) | asset | file-I/O | none (no `public/`, no browser tooling in repo) | no analog |

---

## Pattern Assignments

### `proxy.ts` — EDIT `PUBLIC_PATHS` (middleware, request-response)

**Analog:** self (`/Users/rob/Desktop/projects/Apps/mail-merge/proxy.ts`)

This is the single locked mechanism for signed-out access. **Only the `PUBLIC_PATHS` array changes** — the `clerkMiddleware` body and `config.matcher` stay untouched. Do NOT create `middleware.ts` (silently ignored in Next 16 — the file header documents this).

**Current allowlist** (proxy.ts:22-24):
```typescript
// Public paths that must remain reachable without a session: the Clerk sign-in
// and sign-up catch-all pages (and their sub-routes).
const PUBLIC_PATHS = [/^\/sign-in(\/.*)?$/, /^\/sign-up(\/.*)?$/];
```

**Target** (add four anchored regexes — anchoring `^…$` is a security control per RESEARCH V4/threat table; a too-broad regex would expose `/dashboard`, `/settings`, `/api/*`):
```typescript
const PUBLIC_PATHS = [
  /^\/$/,                   // landing
  /^\/docs(\/.*)?$/,        // docs
  /^\/self-host(\/.*)?$/,   // self-host
  /^\/agents(\/.*)?$/,      // agents
  /^\/sign-in(\/.*)?$/,     // (existing)
  /^\/sign-up(\/.*)?$/,     // (existing)
];
```

**Middleware body unchanged** (proxy.ts:26-29 — copy semantics, do not alter):
```typescript
export default clerkMiddleware(async (auth, req) => {
  const isPublic = PUBLIC_PATHS.some((p) => p.test(req.nextUrl.pathname));
  if (!isPublic) await auth.protect(); // redirects to NEXT_PUBLIC_CLERK_SIGN_IN_URL
});
```

**Post-edit verification (RESEARCH Security "Verification step"):** confirm a signed-out request to `/dashboard`, `/settings/smtp`, and an `/api` route still redirects/401s, and the four new routes return 200.

---

### `app/(marketing)/page.tsx` — landing `/` (RSC page, request-response)

**Analogs:** `app/(app)/dashboard/page.tsx` (the `auth()` idiom) + `app/page.tsx` (the redirect being replaced).

Per D-7 the landing moves INTO the `(marketing)` group (route groups are URL-transparent, so `app/(marketing)/page.tsx` still serves `/`) to inherit the marketing header + footer. The old unconditional redirect is replaced with a **server-side session gate** (no flash — Pitfall 2).

**Replace this** (`app/page.tsx:8-10`, current):
```typescript
export default function Home() {
  redirect("/dashboard");
}
```

**Session-gate pattern — copy the `auth()` idiom verbatim from `app/(app)/dashboard/page.tsx:33-34`:**
```typescript
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");
  return ( /* Landing JSX — see below */ );
}
```

**Landing content idioms** (reuse the established page-content vocabulary from dashboard/settings):
- Hero headline: Display size = `text-[28px] font-semibold leading-[1.2]` (dashboard:43, settings:36), MAY add `sm:`/`lg:` scale-up per D-3, keep base 28px.
- Section headings: `text-xl` weight 600 (dashboard:46,77 CardTitle `text-xl`).
- Muted secondary/prose text: `text-base text-muted-foreground` (settings:37) / `text-sm text-muted-foreground` (footer).
- Section stacking: `flex flex-col gap-8` (dashboard:42, settings:32).
- Container: `mx-auto` centered; marketing uses `max-w-5xl` (hero/grid) / `max-w-3xl` (prose) per D-1 — WIDER than the app's `max-w-2xl` (layout:36) by deliberate decision.
- Primary CTA (single accent, D-4): default `Button asChild` wrapping `<Link href="/sign-up">Get started</Link>` — exact idiom from dashboard:54-56.
- Two-niche + feature Cards: `Card`/`CardHeader`/`CardTitle`/`CardContent` (dashboard:44-58 import block at lines 8-16).
- Icons: `lucide-react`, decorative `text-muted-foreground` only (D-8), never accent.

**Copy is fixed** by the UI-SPEC Copywriting Contract (Landing table) — use those exact strings.

---

### `app/(marketing)/layout.tsx` — marketing shell (layout, request-response)

**Analog:** `app/(app)/layout.tsx` (`/Users/rob/Desktop/projects/Apps/mail-merge/app/(app)/layout.tsx`)

The `(app)` layout renders `<SiteFooter/>` at line 38; the marketing layout does the same so the footer appears on public pages WITHOUT touching the root layout (adding it to root would double-render on authed pages — RESEARCH Pattern 3 / Anti-Patterns). Both groups nest under the single root `ClerkProvider` (`app/layout.tsx:24`) — do NOT add another provider.

**Footer import + placement — copy from `app/(app)/layout.tsx:4` and `:38`:**
```tsx
import { SiteFooter } from "@/components/site-footer";
// …
<SiteFooter />   // rendered after <main>, inside the flex-col column
```

**Header idiom — mirror the app top bar `h-16 … border-b px-…` (app layout:31), simplified to wordmark + Sign in** (RESEARCH Pattern 3 example; matches UI-SPEC Surface Inventory "Marketing layout"):
```tsx
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
Note: "Sign in" is `variant="outline"` (neutral), NOT accent — the single page accent is the landing "Get started" CTA (D-4).

---

### `app/(marketing)/docs/page.tsx` — `/docs` (RSC page, request-response)

**Analog:** `app/(app)/settings/smtp/page.tsx:29-44` (heading block + prose sections).

Pure static prose; no `auth()`, no data fetch. Reuse the heading + intro idiom:

**Heading + intro block — copy structure from settings/smtp:29-39:**
```tsx
<div className="mx-auto w-full max-w-3xl flex flex-col gap-8 py-12">
  <div className="flex flex-col gap-2">
    <h1 className="text-[28px] font-semibold leading-[1.2]">Using Mail Merge</h1>
    <p className="text-base text-muted-foreground">A run goes onboard → upload → …</p>
  </div>
  {/* 7 numbered step sections: <h2 class="text-xl font-semibold …"> + <p class="text-base"> */}
  <Separator />
  {/* CLI/MCP pointer → <Link href="/agents"> as neutral underlined text (D-5) */}
</div>
```
- Step headings: `text-xl` weight 600 (Heading role).
- Inline links: neutral underlined text `underline underline-offset-4 hover:text-foreground` — copy the exact idiom from `components/site-footer.tsx:21` (D-5), NOT accent.
- `Separator` from `components/ui/separator.tsx` for section dividers.
- Copy is fixed by UI-SPEC Docs table (7 step headings + intro + pointer).

---

### `app/(marketing)/self-host/page.tsx` — `/self-host` (RSC page, request-response)

**Analogs:** `app/(app)/dashboard/page.tsx` (Card sections) + **content source `.env.example`** (`/Users/rob/Desktop/projects/Apps/mail-merge/.env.example`).

Env-var documentation MIRRORS `.env.example` (the "COMPLETE contract" per its own header, line 6). **Show placeholder names + the generator command ONLY — never a real key or full `.env`** (RESEARCH Security: Information Disclosure).

**Vars to document (names/semantics from `.env.example`, do NOT invent):**
- `DATABASE_PATH` → `/data/app.db` in prod (env.example:20-23) — runtime
- `UPLOADS_PATH` → `/data/uploads` in prod (env.example:25-30) — runtime
- `CREDENTIAL_ENC_KEY` — RUNTIME SECRET, `openssl rand -base64 32`, "FAILS LOUDLY at startup if absent or not 32 bytes" (env.example:32-40)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — BUILD-TIME, inlined by `next build` (env.example:42-56)
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` etc. — BUILD-TIME (env.example:61-68)
- `CLERK_SECRET_KEY` — RUNTIME SECRET, never a build arg (env.example:57-60)

**Emphasize the build-vs-runtime split** — `.env.example:7-12` calls it out explicitly; UI-SPEC Self-host copy repeats it.

**Code/command blocks** (env-var examples, `openssl` command): `bg-muted rounded-md p-4 text-sm`, `font-mono` inside the block only (D-2 — browser default mono stack, NOT a font package). Group vars into `Card`s (reuse `components/ui/card.tsx`). Copy fixed by UI-SPEC Self-host table.

---

### `app/(marketing)/agents/page.tsx` — `/agents` (RSC page, content-mirror)

**Analog / content source:** `packages/cli/README.md` (`/Users/rob/Desktop/projects/Apps/mail-merge/packages/cli/README.md`).

Code blocks must be **VERBATIM** from the CLI README so copy-paste actually works (Pitfall 4 — package name, flags, and the `-y` in `npx -y` must match exactly). Add a snippet-parity check against `packages/cli/README.md`.

**Canonical npx invocation (README:24):**
```bash
npx @robindarlington/mail-merge --csv data.csv --template msg.txt   # dry-run (default)
```

**Canonical MCP config (README:142-151) — copy exactly:**
```json
{
  "mcpServers": {
    "mail-merge": {
      "command": "npx",
      "args": ["-y", "@robindarlington/mail-merge", "mcp"]
    }
  }
}
```

- Render in `<pre>`/code blocks: `bg-muted rounded-md p-4 text-sm` + `font-mono` (block only, D-2). No syntax-highlighter (forbidden dep).
- Section headings (`Quick start (CLI)` · `Dry-run, test, send` · `Use it from an MCP client`): `text-xl` weight 600.
- Page heading `CLI and MCP for agents`: Display `text-[28px] font-semibold leading-[1.2]`.
- Intro copy notes "Zero install via npx; requires Node.js 18 or newer" — matches README:14. Copy fixed by UI-SPEC Agents table.

---

### `lib/config.ts` — flip `HIRE_ME_URL` (config, single-value edit)

**Analog:** self (`/Users/rob/Desktop/projects/Apps/mail-merge/lib/config.ts`).

Single-value flip; the file's own comment (lines 6-8) says Phase 9 does exactly this. No other code changes (`site-footer.tsx:18` reads the constant, unchanged).

**Change line 12:**
```typescript
// FROM:
export const HIRE_ME_URL = "https://example.com/hire-me";
// TO:
export const HIRE_ME_URL = "https://robindarlington.com/contact/";
```
Update the adjacent placeholder comment so it no longer says "placeholder". Do NOT leave it at `example.com` (Pitfall 3 — BRAND-01 link would 404 in prod).

---

### `components/site-footer.tsx` — REUSE (component, no change)

**Analog:** self. No edit — it already renders `HIRE_ME_URL` and its copy is locked ("Built by Robin Darlington · Hire me for custom tools"). It gains public-page coverage purely by being rendered in the new `(marketing)/layout.tsx`. Its link idiom (`underline underline-offset-4 hover:text-foreground`, footer:21) is the reference for all marketing inline links (D-5).

---

### `README.md` — repo root (Markdown doc, no code analog)

**Analog:** `packages/cli/README.md` (structure/tone) + RESEARCH.md README skeleton (lines 308-319).

Required sections (RESEARCH + CONTEXT): title + repo link `https://github.com/robindarlington/mail-merge`; one-line what-it-is; **≥1 screenshot via RELATIVE path** `![Landing](docs/screenshots/landing.png)` so it renders on GitHub (Pitfall 6 — NOT `/public`); two niches (credential delivery · per-row documents); feature list; quickstart (node >=24, `npm install`, `.env` per `.env.example`, `npm run dev`); self-host pointer → `/self-host` + `docs/`; CLI/MCP pointer → `packages/cli/README.md` + `/agents`; License MIT; Author "Built by Robin Darlington" + `https://robindarlington.com/contact/`.

Mirror the CLI README's Author/License idiom (`packages/cli/README.md:184-192`) but point the hire-me link at the real contact URL (not the GitHub placeholder the CLI README currently uses).

---

### `docs/writeup.md` — NEW (Markdown doc, no analog)

**Analog:** none — new artifact. Brief from CONTEXT (lines 25-26) / RESEARCH: the story of generalizing the one-off credential-delivery CLI (`send-credentials.ts`) into a self-serve product; architecture choices (Next.js + SQLite + worker on Coolify, BYO SMTP); the spec-driven AI-assisted build process. Draft = publishable with light editing; Rob publishes manually at robindarlington.com/thoughts/. Tone per Copywriting Contract: honest, plain-spoken, no fabricated metrics.

---

### `docs/screenshots/*.png` — NEW assets (file-I/O, no analog)

**Analog:** none — repo has no `public/` dir and no Playwright/browser tooling. Capture public pages headlessly if executor browser tooling is available; queue authed captures (dashboard, compose, campaign progress) as a Rob checkpoint otherwise (RESEARCH Open Q1, A1). Store under `docs/screenshots/`, reference from README with relative paths. Every image needs descriptive `alt`. Do NOT add Playwright just for this (out of scope).

---

## Shared Patterns

### Attribution footer (BRAND-01)
**Source:** `components/site-footer.tsx` (+ `lib/config.ts` `HIRE_ME_URL`)
**Apply to:** `(marketing)/layout.tsx` (already in `(app)/layout.tsx:38`)
```tsx
import { SiteFooter } from "@/components/site-footer";
// … render <SiteFooter /> once per layout, after <main>. Never in root layout.
```

### Server-side auth gate
**Source:** `app/(app)/dashboard/page.tsx:33-34`
**Apply to:** `app/(marketing)/page.tsx` (landing redirect)
```tsx
const { userId } = await auth();   // from "@clerk/nextjs/server"
if (userId) redirect("/dashboard");
```

### Page-content typography + spacing vocabulary
**Source:** `app/(app)/dashboard/page.tsx` + `app/(app)/settings/smtp/page.tsx`
**Apply to:** all four marketing pages
```tsx
<div className="flex flex-col gap-8">                          {/* section stack */}
  <h1 className="text-[28px] font-semibold leading-[1.2]">…</h1> {/* Display */}
  <p  className="text-base text-muted-foreground">…</p>          {/* muted prose */}
  {/* section headings: className="text-xl font-semibold" (600) */}
</div>
```
Marketing containers widen to `max-w-3xl`/`max-w-5xl` (`mx-auto px-6`) vs the app's `max-w-2xl` (D-1).

### Neutral inline-link idiom (NOT accent)
**Source:** `components/site-footer.tsx:21`
**Apply to:** every prose/inline `<Link>`/`<a>` on docs/self-host/agents (D-5)
```tsx
className="underline underline-offset-4 hover:text-foreground"
```

### CTA button idiom (single accent per page)
**Source:** `app/(app)/dashboard/page.tsx:54-56`
**Apply to:** landing "Get started" (accent, default variant); header "Sign in" (`variant="outline"`, D-4)
```tsx
<Button asChild><Link href="/sign-up">Get started</Link></Button>
```

### Code/command block idiom (no new deps)
**Source:** UI-SPEC Component Inventory + D-2 (no monospace font package)
**Apply to:** agents, self-host, docs snippets
```tsx
<pre className="bg-muted rounded-md p-4 text-sm font-mono overflow-x-auto">…</pre>
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `docs/writeup.md` | doc (Markdown) | — | New narrative artifact; no prior write-up in repo. Brief lives in CONTEXT/RESEARCH. |
| `docs/screenshots/*.png` | asset | file-I/O | No `public/` dir, no browser/Playwright tooling in repo; capture path is executor-tooling-dependent (RESEARCH Open Q1). |

README.md has no direct in-repo code analog but reuses `packages/cli/README.md` structure and the RESEARCH.md skeleton — treat as partial.

---

## Metadata

**Analog search scope:** `app/` (root, `(app)`, `(marketing)` target, `sign-in`), `components/`, `components/ui/`, `lib/`, `packages/cli/`, repo root (`proxy.ts`, `.env.example`), `docs/` (absent).
**Files scanned:** proxy.ts, app/page.tsx, app/layout.tsx, app/(app)/layout.tsx, app/(app)/dashboard/page.tsx, app/(app)/settings/smtp/page.tsx, app/sign-in/[[...sign-in]]/page.tsx, components/site-footer.tsx, components/ui/button.tsx, lib/config.ts, packages/cli/README.md, .env.example (12 read; full app/components/ui/ listing enumerated).
**Pattern extraction date:** 2026-07-19
