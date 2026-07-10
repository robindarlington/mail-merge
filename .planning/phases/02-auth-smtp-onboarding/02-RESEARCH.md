# Phase 2: Auth + SMTP Onboarding - Research

**Researched:** 2026-07-10
**Domain:** Clerk auth on Next.js 16 App Router + nodemailer SMTP verification + encrypted credential persistence + first Coolify staging deploy
**Confidence:** HIGH (core patterns verified against official Clerk/nodemailer/shadcn docs and the live npm registry this session; MEDIUM only on TLS-retry classification heuristics and Coolify deploy mechanics)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Onboarding Flow Shape**
- **D-01:** Multi-step wizard: Step 1 server details form → Step 2 live verify with feedback → Step 3 optional test-send to the user's own address. Each step gates the next.
- **D-02:** Soft gate: after sign-up the user lands on the dashboard with a prominent "Set up your SMTP server" callout. The rest of the app (as it grows in later phases) stays browsable without SMTP; only sending features require a verified config. Rationale: keeps future demo/sandbox mode (DEMO-01, v2) easy to add and fits the funnel goal (see PROJECT.md Business Context).
- **D-03:** The final test-send-to-self step is offered prominently but skippable — the roadmap criterion says "offers"; `verify()` already proved the connection.

**Verify & Error UX**
- **D-04:** Verify-then-save as ONE action: "Verify & continue" runs `transport.verify()` and only persists the encrypted config when it succeeds. An unverified config can never be saved (`verified_at` set on success).
- **D-05:** TLS auto-retry: on a TLS-shaped verify failure, silently retry the alternate mode (implicit SSL ↔ STARTTLS). If the alternate works, suggest a one-click switch ("Your server needs STARTTLS — switch and continue?"). Implements the PITFALLS #3 mitigation as UX.
- **D-06:** Errors are mapped and field-anchored: `EAUTH` → "username or password rejected" anchored to those fields; `ETIMEDOUT`/connection → "couldn't reach host:port" anchored to host/port; TLS errors → anchored to the TLS mode toggle. Raw SMTP/nodemailer error text available in an expandable detail for technical users.

**Editing Saved Config**
- **D-07:** On edit, the password field renders blank with "leave blank to keep current password". The stored password is NEVER sent to the client (SMTP-04); a typed value replaces it.
- **D-08:** Re-verify is required only when connection fields change (host, port, secure, username, password) — this clears `verified_at` until a fresh verify passes. `from_name`/`from_addr` edits save directly without a verify round-trip.
- **D-09:** No delete in v1 — edit/replace only. Preserves FK integrity (`campaigns.smtp_config_id` will reference it for history) and there's no use case with a single profile (multiple profiles = v2 CONV-03).

**Sign-in & App Shell**
- **D-10:** Clerk prebuilt components: dedicated `/sign-in` and `/sign-up` pages using `<SignIn/>`/`<SignUp/>`, themed to match Tailwind/shadcn. No custom auth forms.
- **D-11:** Build the shadcn sidebar shell skeleton in this phase: nav slots (Dashboard, SMTP Settings now; Campaigns/History appear in later phases), Clerk user button top-right, standard page container. Later phases drop pages into it.
- **D-12:** Basic attribution footer starts NOW: "Built by Robin Darlington" + hire-me/support link (placeholder URL the user will set later). BRAND-01 formally completes in Phase 9, but the staging URL is shareable from this phase on, so the funnel link exists from day one.
- **D-13:** Staging uses the Clerk development instance (same test keys as local dev). A production Clerk instance (custom domain, prod keys) is Phase 8 work.

### Claude's Discretion
- Route structure, middleware wiring, Server Actions vs Route Handlers split, exact wizard step components and copy, verify timeout duration, zod schemas — researcher/planner decide within the decisions above.
- Common-provider presets (e.g. Gmail/Outlook host autofill) were not requested — optional polish only if cheap.
- Exact staging deploy mechanics (Coolify app setup, env wiring) — follow the Phase 1 Compose skeleton; full hardening remains Phase 8.

### Deferred Ideas (OUT OF SCOPE)
- Demo/sandbox transport (DEMO-01) — v2; the soft gate keeps space for it.
- Multiple SMTP profiles per user (CONV-03) — v2; drives the no-delete decision.
- SPF/DKIM DNS hints at onboarding (DNS-01) — v2; noted as a consulting hook.
- Production Clerk instance + custom domain — Phase 8.
- Common-provider host presets — optional polish, only if trivially cheap during execution.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | User can sign up and sign in via Clerk | Clerk `@clerk/nextjs` 7.5.16 quickstart pattern verified: `proxy.ts` + `clerkMiddleware()`, `<ClerkProvider>` inside `<body>`, dedicated `/sign-in` + `/sign-up` catch-all pages with `<SignIn/>`/`<SignUp/>` (Code Examples 1–3) |
| AUTH-02 | All user data scoped to signed-in user | DAL pattern: every query function takes a required `userId` from `await auth()`; DTO layer strips the encrypted triple (Pattern 3, Code Example 5); cross-tenant test in Validation Architecture |
| AUTH-03 | Unauthenticated users redirected to sign-in for all app routes | `proxy.ts` with `auth.protect()` for non-public paths (Code Example 1) + known redirect bug workaround (`NEXT_PUBLIC_CLERK_SIGN_IN_URL`) — see Pitfall 2 |
| SMTP-01 | User enters host/port/username/password/from-name/from-address | shadcn + react-hook-form + zod 4 form stack (verified via shadcn official docs); zod schema in Code Example 6 |
| SMTP-02 | Explicit TLS mode (implicit SSL vs STARTTLS), not inferred from port | `smtp_configs.secure` column already exists (Phase 1); form exposes an explicit radio/toggle; `requireTLS: true` set whenever `secure: false` (verified against nodemailer docs) |
| SMTP-03 | Live connection check before save, distinguishing auth vs host/port vs TLS failure | `transport.verify()` with short timeouts (nodemailer defaults are 120s connect — verified); error classifier maps `EAUTH`/`EDNS`/`ECONNECTION`/`ETIMEDOUT`/`ESOCKET` to field-anchored messages (Code Example 4); D-05 auto-retry logic |
| SMTP-04 | Credentials AES-256-GCM at rest; password never in client responses or logs | `lib/crypto` encrypt() already built (Phase 1); DTO pattern + redaction test + grep gate carry-forward (Pattern 3) |
| SMTP-05 | Onboarding completes only after successful validation, with optional test-send | D-04 verify-then-save single action sets `verified_at`; test-send step reuses `lib/core/send.ts` `sendOne()` with the decrypted saved config |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Tech stack locked:** Next.js (App Router) + Clerk + Tailwind + shadcn/ui; SQLite backend; nodemailer over BYO SMTP; plain-text email only.
- **Security:** per-user SMTP credentials encrypted at rest; SMTP password never committed or logged; carry forward `transport.verify()` before any send.
- **Deployment:** Coolify on VPS (containerized) — informs packaging of web app + SQLite volume.
- **Code style:** 2-space indent, double quotes, semicolons, trailing commas, camelCase functions, PascalCase types, JSDoc on top-level functions, ESM only.
- **Error handling convention:** throw early with descriptive human-readable messages; per-item failures caught without aborting batches.
- **GSD workflow enforcement:** all file changes flow through GSD commands.
- **Attribution (memory):** no Claude attribution in this repo; commits credit Robin Darlington; hire-me link in UX (D-12 implements this).

## Summary

Phase 2 is a wiring phase, not an invention phase. Everything hard was built in Phase 1: `lib/crypto` (AES-256-GCM triple), `lib/db` (single WAL'd opener + `smtp_configs` table with explicit `secure` and `verified_at`), and `lib/core/send.ts` (transport factory + `verifyTransport` + `sendOne`). Phase 2 adds the Clerk layer, a three-step wizard UI in a shadcn sidebar shell, a thin server-side data-access layer that enforces `userId` scoping, and the first staging deploy.

Two ecosystem shifts discovered this session materially affect planning. First, **Next.js 16 renamed `middleware.ts` to `proxy.ts`** — a `middleware.ts` file in a Next 16 project is *silently ignored* (no warning, no route protection), so the Clerk middleware MUST live in `proxy.ts` at the repo root. Second, **Clerk deprecated `createRouteMatcher()`** in favor of resource-based auth checks; the correct architecture is a thin `proxy.ts` that calls `auth.protect()` for non-public paths (satisfying AUTH-03's redirect requirement) *plus* per-resource `userId` checks in every Server Action and data-access function (satisfying AUTH-02 as defense in depth). A related known bug (clerk/javascript#8302) makes `auth.protect()` redirect wrongly unless `NEXT_PUBLIC_CLERK_SIGN_IN_URL` is set — we set it anyway for the dedicated sign-in page.

On the SMTP side, nodemailer 9's default timeouts are far too generous for onboarding UX (connectionTimeout 120s, greetingTimeout 30s — verified against official docs), so the verify transport must set explicit short timeouts (~10s). The error-classification mapping for D-06 is well-grounded (`EAUTH`, `EDNS`, `ECONNECTION`, `ETIMEDOUT` verified); the *TLS-shaped* failure signatures needed for D-05's auto-retry (wrong-version-number `ESOCKET` vs greeting-timeout) are training-informed and should be pinned down empirically with the `smtp-server` dev package during execution.

**Primary recommendation:** Build `proxy.ts` + ClerkProvider + sign-in/up pages first (thin slice proving auth end-to-end), then the wizard as Server Actions over a `userId`-scoped DAL that extends — never bypasses — the Phase 1 `lib/` modules, then deploy to Coolify staging with the Clerk publishable key passed as a Docker build arg.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Sign-up / sign-in UI | Frontend server (Clerk prebuilt `<SignIn/>`/`<SignUp/>` pages) | Clerk FAPI (external) | D-10 locks prebuilt components; Clerk hosts the auth logic |
| Session verification + route redirect (AUTH-03) | Frontend server (`proxy.ts` → `clerkMiddleware` + `auth.protect()`) | — | Runs before any route; only place that can redirect *every* request |
| Per-row tenant authorization (AUTH-02) | API/Backend (Server Actions + DAL) | Database (queries always filtered by `userId`) | Clerk deprecation guidance: protect "as close to the resource as possible" |
| Wizard step state + form UX | Browser (client components, react-hook-form) | — | Multi-step interactivity, field-anchored errors, optimistic UI |
| Input validation | API/Backend (zod parse inside Server Action) | Browser (same zod schema via RHF resolver for instant UX) | Server-side parse is authoritative; client-side is convenience only |
| `transport.verify()` + TLS auto-retry | API/Backend (Server Action, Node runtime) | — | Needs raw TCP/TLS — server-only; persistent Node server means no function-timeout constraint |
| Credential encryption | API/Backend (`lib/crypto`) | — | Key is server-only env (`CREDENTIAL_ENC_KEY`); never reaches any other tier |
| Config persistence | Database (SQLite via `lib/db` sole opener) | — | D-04 from Phase 1: never open a second connection |
| Test-send | API/Backend (`lib/core/send.ts` `sendOne`) | — | Reuses the proven transport engine; decrypt only server-side at send time |
| App shell (sidebar, footer, user button) | Frontend server (RSC layout) | Browser (shadcn sidebar interactivity) | D-11/D-12; layout is the natural owner of nav + footer |
| Staging deploy | Infra (Coolify/Docker Compose on VPS) | — | Phase 1 compose skeleton; hardening deferred to Phase 8 |

## Standard Stack

### Core (already installed — no new installs needed for the core path)

| Library | Version (installed / registry) | Purpose | Why Standard |
|---------|-------------------------------|---------|--------------|
| `@clerk/nextjs` | ^7.5 (registry 7.5.16) | Auth: `clerkMiddleware`, `auth()`, prebuilt components | Locked constraint; version verified current `[VERIFIED: npm registry]` |
| `next` | ^16.2 | App Router, Server Actions, `proxy.ts` | Locked; persistent `node server.js` host |
| `nodemailer` | ^9 (registry 9.0.3) | `verify()` + `sendMail` via `lib/core/send.ts` | Locked; reuse Phase 1 module `[VERIFIED: npm registry]` |
| `zod` | ^4.4 | SMTP form schema, Server Action input validation | Already installed; note zod 4 API (`z.email()` top-level) |
| `drizzle-orm` + `better-sqlite3` | ^0.45 / ^12.11 | `userId`-scoped queries over `smtp_configs` | Phase 1 foundation; use `lib/db` client only |
| shadcn/ui (Tailwind 4, radix-nova style) | CLI-scaffolded | Wizard forms, sidebar shell, alerts, dialogs | Already initialized (`components.json`) |

### New packages this phase

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `react-hook-form` | 7.81.0 | Wizard form state + field-anchored errors (D-06) | shadcn's documented form stack `[VERIFIED: npm registry]` (shadcn official docs confirm the react-hook-form + `@hookform/resolvers` + zod pattern) |
| `@hookform/resolvers` | 5.4.0 | zod resolver bridging RHF ↔ the shared zod schema | With react-hook-form `[VERIFIED: npm registry]` |
| `@clerk/ui` | 1.25.2 | Official `shadcn` theme for Clerk components (D-10 "themed to match Tailwind/shadcn") | Import `shadcn` theme from `@clerk/ui/themes`, pass via `appearance` prop `[VERIFIED: npm registry + Clerk official docs]` |
| `smtp-server` (dev dep) | 3.19.2 | Local real-SMTP fixture for automated verify/error-mapping tests (EAUTH, STARTTLS vs implicit-TLS) | Maintained by the nodemailer author (andris); test-only `[VERIFIED: npm registry]` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| react-hook-form | Plain `useState` + zod parse on submit | Fewer deps, but D-06's field-anchored server-error mapping is exactly what RHF's `setError(field, …)` does well; shadcn form docs assume it |
| `@clerk/ui` theme | Hand-tuned `appearance.variables` | More control, more work; official shadcn theme is Tailwind-4-compatible and one line |
| `smtp-server` test fixture | Ethereal.email live test accounts | Ethereal needs network + external service in CI; local `smtp-server` is deterministic and can simulate auth-reject/TLS-mismatch precisely |
| Server Actions for wizard mutations | Route Handlers (`POST /api/smtp/verify`) | Server Actions: less wiring, typed returns, built-in CSRF origin checks; Route Handlers only needed when a non-form client calls it — not the case here. **Recommend Server Actions.** |

**Installation:**
```bash
npm install react-hook-form @hookform/resolvers @clerk/ui
npm install -D smtp-server @types/smtp-server
npx shadcn@latest add sidebar button card input label radio-group alert dialog sonner skeleton separator badge
```

**Version verification:** performed this session (2026-07-10) via `npm view <pkg> version` — `@clerk/nextjs` 7.5.16, `nodemailer` 9.0.3, `react-hook-form` 7.81.0, `@hookform/resolvers` 5.4.0, `@clerk/ui` 1.25.2 (modified 2026-07-10), `smtp-server` 3.19.2 (modified 2026-07-05).

## Package Legitimacy Audit

slopcheck 0.6.1 was installed and run this session. Note for the planner: `slopcheck install` wraps `npm install`, so run it *as* the install step (or in a sandbox), not before it.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| react-hook-form | npm | since 2019 | very high | github.com/react-hook-form/react-hook-form | [OK] | Approved |
| @hookform/resolvers | npm | mature | very high | github.com/react-hook-form/resolvers | [OK] | Approved |
| @clerk/ui | npm | active (updated 2026-07-10) | official Clerk scope | github.com/clerk/javascript | [OK] | Approved |
| @clerk/themes | npm | mature | official Clerk scope | github.com/clerk/javascript | [OK] | **Not needed** — superseded by `@clerk/ui` for the shadcn theme per current Clerk docs |
| smtp-server | npm | mature | high | github.com/nodemailer/smtp-server (maintainer: andris, nodemailer author) | [OK] | Approved (devDependency) |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**Postinstall scripts:** none of the above declare a `postinstall` script (checked via `npm view <pkg> scripts.postinstall`).

## Architecture Patterns

### System Architecture Diagram

```
                     Browser
                        │
     ┌──────────────────┼─────────────────────────────┐
     │ unauthenticated  │ authenticated               │
     ▼                  ▼                             │
┌─────────┐   ┌──────────────────────┐                │
│ proxy.ts │──│ clerkMiddleware       │  (Next 16: file MUST be proxy.ts)
│          │  │ non-public → protect()│──redirect──▶ /sign-in (<SignIn/>, Clerk FAPI)
└─────────┘   └──────────┬───────────┘
                         ▼
          ┌───────────────────────────────┐
          │ App shell layout (RSC)        │  ClerkProvider (inside <body>)
          │ shadcn sidebar + UserButton   │  + attribution footer (D-12)
          └───────┬───────────────┬───────┘
                  ▼               ▼
          /dashboard        /settings/smtp (wizard)
          soft-gate callout   Step1 form ──▶ Step2 verify ──▶ Step3 test-send
          (D-02)                    │ Server Action              │ Server Action
                                    ▼                            ▼
                        ┌────────────────────┐        ┌────────────────────┐
                        │ verifyAndSave      │        │ sendTestEmail      │
                        │ 1 await auth()     │        │ 1 await auth()     │
                        │ 2 zod parse        │        │ 2 load config(DAL) │
                        │ 3 build transport  │        │ 3 decrypt password │
                        │   (short timeouts, │        │ 4 sendOne() to own │
                        │    requireTLS)     │        │   address          │
                        │ 4 verify()         │        └─────────┬──────────┘
                        │ 4b TLS auto-retry  │                  │
                        │ 5 encrypt()        │                  ▼
                        │ 6 upsert + set     │           user's SMTP server
                        │   verified_at      │
                        └─────────┬──────────┘
                                  ▼
                     lib/db (sole SQLite opener) ──▶ smtp_configs
                     every query: WHERE user_id = auth().userId
```

### Recommended Project Structure

```
proxy.ts                      # clerkMiddleware — Next 16 name (NOT middleware.ts)
app/
├── layout.tsx                # + ClerkProvider (inside <body>), @clerk/ui shadcn theme
├── sign-in/[[...sign-in]]/page.tsx
├── sign-up/[[...sign-up]]/page.tsx
├── (app)/                    # authenticated shell route group
│   ├── layout.tsx            # shadcn sidebar shell + UserButton + footer (D-11/D-12)
│   ├── dashboard/page.tsx    # soft-gate callout (D-02)
│   └── settings/smtp/page.tsx  # wizard entry (also the edit flow, D-07/D-08)
├── page.tsx                  # / → redirect to /dashboard (signed-in) — proxy protects it
components/
├── ui/…                      # shadcn primitives (CLI-added)
├── app-sidebar.tsx           # nav slots: Dashboard, SMTP Settings (+future)
├── site-footer.tsx           # attribution + HIRE_ME_URL constant (D-12)
└── smtp/                     # wizard step components (client)
lib/
├── config.ts                 # HIRE_ME_URL placeholder constant (single value, Phase 9 flips it)
├── smtp/
│   ├── schema.ts             # zod form schema (shared client+server)
│   ├── errors.ts             # nodemailer error → {kind, field, message} classifier (D-06)
│   ├── verify.ts             # verify-with-timeouts + TLS auto-retry (D-05)
│   └── actions.ts            # "use server": verifyAndSave, updateFromFields, sendTestEmail
└── data/
    └── smtp.ts               # DAL: getSmtpConfigForUser(userId), upsertSmtpConfig(userId, …), toSmtpConfigDto
```

### Pattern 1: `proxy.ts` route protection (AUTH-03)

**What:** Thin middleware that redirects unauthenticated requests on all non-public routes; everything else is resource-level.
**When to use:** This exact file, once. Clerk deprecated `createRouteMatcher()` — do NOT centralize fine-grained authorization here; the middleware only answers "signed in at all?".
**Example:** see Code Example 1.

### Pattern 2: Every mutation is a Server Action that re-derives `userId` (AUTH-02)

**What:** Each action begins `const { userId } = await auth(); if (!userId) …reject`. The DAL functions take `userId` as a *required first parameter* — there is no query path that omits it. The worker (Phase 6) will pass the campaign row's `userId` the same way, so the DAL stays request-context-free.
**When to use:** All reads/writes of `smtp_configs` (and every tenant table in later phases — this phase sets the convention).

### Pattern 3: DTO redaction boundary (SMTP-04, D-07)

**What:** A `toSmtpConfigDto()` function is the only thing allowed to cross the server→client boundary. It explicitly picks safe fields (`host, port, secure, username, from_addr, from_name, verified_at`) and structurally cannot include `password_enc/_iv/_tag`. Server Actions return typed `{ ok, … } | { ok: false, error: {kind, field, message, raw} }` values — never a thrown raw nodemailer error (Next masks prod errors, but returning typed results is the contract).
**When to use:** Any response that describes the SMTP config, including the edit form's initial values (password field always blank per D-07).

### Pattern 4: Verify-then-save as one action with TLS auto-retry (D-04, D-05)

**What:** One Server Action: parse → build transport with short timeouts → `verify()` → on TLS-shaped failure, retry once with `secure` flipped → on success with the *original* mode, `encrypt()` and upsert with `verified_at = unixepoch`; on success only with the *alternate* mode, do NOT save — return `{ ok: false, suggestion: "starttls" | "implicit" }` so the UI offers the one-click switch (the user re-submits with the switched mode, which then verifies and saves).
**When to use:** Step 2 of the wizard and any edit that touches connection fields (D-08).

### Pattern 5: Single-config upsert (D-09)

**What:** One `smtp_configs` row per user, enforced by upsert-on-`user_id`. The Phase 1 schema has no UNIQUE on `user_id`; add an additive migration `CREATE UNIQUE INDEX smtp_configs_user_uq ON smtp_configs(user_id)` so Drizzle's `onConflictDoUpdate({ target: smtp_configs.userId })` is safe under concurrency, instead of a read-then-insert race.
**When to use:** The save step of `verifyAndSave` and the `from_*`-only edit path.

### Anti-Patterns to Avoid

- **`middleware.ts` in a Next 16 repo:** silently ignored — zero route protection with no error. The file must be `proxy.ts` (root).
- **Auth logic only in middleware:** Clerk explicitly deprecates route-matcher-driven protection; per-resource `userId` checks are mandatory regardless (PITFALLS #13).
- **Opening a second SQLite connection:** `lib/db/client.ts` is the sole opener (Phase 1 D-04). Server Actions import `db` from `@/lib/db`.
- **Passing the decrypted password (or full transport config) into any log, error object, or client return value:** carry forward the `lib/core` grep-enforced rule into `lib/smtp/*` and `lib/data/*`.
- **Inferring `secure` from the port:** the form defaults MAY suggest (465→implicit, 587→STARTTLS) but the stored value is always the explicit user choice (SMTP-02).
- **`rejectUnauthorized: false`:** never as a default (nodemailer docs: "should not be used in production").

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Auth, sessions, sign-in UI | Custom auth forms/JWT handling | Clerk prebuilt components + `clerkMiddleware` | Locked (D-10); session/token edge cases are Clerk's job |
| Form state + per-field server errors | useState soup + manual error wiring | react-hook-form + `setError` + zod resolver | D-06's field-anchored errors map 1:1 to RHF's API |
| SMTP protocol, TLS negotiation, timeouts | Raw `net`/`tls` sockets | nodemailer via `lib/core/send.ts` (extended with timeout opts) | Already proven in Phase 1/CLI |
| Credential encryption | Any new crypto code | `lib/crypto` `encrypt()/decrypt()` | Exists, tested, fail-closed key loader |
| Fake SMTP server for tests | Hand-rolled socket listener | `smtp-server` (nodemailer project) | Simulates EAUTH/STARTTLS/implicit-TLS deterministically |
| Sidebar/nav/dialog/toast UI | Custom CSS components | shadcn CLI components (`sidebar`, `sonner`, …) | Already initialized; Tailwind 4 compatible |

**Key insight:** every hard sub-problem in this phase (auth, crypto, SMTP transport, DB access) already has a project-blessed owner. The phase's real work is the seams: scoping, redaction, error mapping, and deploy wiring.

## Common Pitfalls

### Pitfall 1: `middleware.ts` silently ignored on Next.js 16
**What goes wrong:** Clerk middleware placed in `middleware.ts` never runs; every route is publicly accessible with no warning.
**Why it happens:** Next 16 renamed the convention to `proxy.ts`; old file name is ignored, not errored. `[CITED: nextjs.org/docs/messages/middleware-to-proxy, clerk.com/docs/reference/nextjs/clerk-middleware]`
**How to avoid:** Create `proxy.ts` at repo root exporting `clerkMiddleware`. Verification step: `curl -sI localhost:3000/dashboard` unauthenticated must return a redirect to `/sign-in`.
**Warning signs:** App routes render without sign-in during manual testing.

### Pitfall 2: `auth.protect()` redirects to the current URL instead of sign-in
**What goes wrong:** Unauthenticated users loop on the protected page instead of landing on `/sign-in`.
**Why it happens:** Known `@clerk/nextjs` v7 + Next 16 proxy issue (clerk/javascript#8302); fixed by explicitly setting the sign-in URL env. `[CITED: github.com/clerk/javascript/issues/8302]`
**How to avoid:** Always set `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` (needed anyway for the dedicated sign-in page, D-10) plus the fallback-redirect vars.
**Warning signs:** Redirect loop or 404 when hitting a protected route signed-out.

### Pitfall 3: Clerk publishable key missing at Docker build time
**What goes wrong:** `next build` inside the Dockerfile fails (or produces a keyless client bundle) because `NEXT_PUBLIC_*` vars are inlined at build time, and the Phase 1 Dockerfile passes no Clerk env to the build stage.
**Why it happens:** Next.js inlines `NEXT_PUBLIC_*` during `next build`; Coolify runtime env vars are not automatically build args. `[ASSUMED — standard Next.js behavior; verify the Coolify "build variable" toggle on the actual instance]`
**How to avoid:** Add `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (+ sign-in/up URL vars) to the Dockerfile build stage and mark them as build-time variables in Coolify. `CLERK_SECRET_KEY` stays runtime-only (web service env) — never a build arg, never in the image.
**Warning signs:** Build error "Missing publishableKey"; or staging loads but Clerk components render an error.

### Pitfall 4: `verify()` hangs ~2 minutes on a typo'd host
**What goes wrong:** Onboarding spinner runs for minutes; users assume the app is broken.
**Why it happens:** nodemailer defaults verified this session: `connectionTimeout` 120s, `greetingTimeout` 30s, `socketTimeout` 600s, `dnsTimeout` 30s. `[CITED: nodemailer.com/smtp]`
**How to avoid:** Onboarding transport sets `connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000, dnsTimeout: 10_000` and calls `transport.close()` in a `finally`. UI shows progress and treats timeout as a distinct host/port-anchored error (D-06).
**Warning signs:** Verify requests taking >15s in testing.

### Pitfall 5: Secrets leak through Server Action returns or logs
**What goes wrong:** A raw nodemailer error (which can embed connection details) or the config row (with the encrypted triple, or worse a decrypted pass in a debug log) is returned to the client or logged.
**Why it happens:** `return { error: err }` is the path of least resistance; Next serializes whatever you return.
**How to avoid:** Typed result objects only; `toSmtpConfigDto()` as the sole boundary crosser; no `logger`/`debug` on transports; extend the Phase 1 grep gate to `lib/smtp` and `lib/data` (no `console.*`/pino calls referencing `pass|password`); add the node:test asserting a known test password never appears in `JSON.stringify` of any action result.
**Warning signs:** Any `err` object passed outward unmapped; password visible in browser network tab on a failed verify.

### Pitfall 6: `verified_at` survives a connection-field edit
**What goes wrong:** User edits host/username, skips re-verify, and Phase 5/6 later sends through an unverified (broken) config because `verified_at` still looks valid.
**Why it happens:** D-08's two edit paths (connection fields vs from-fields) are easy to collapse into one update.
**How to avoid:** Two distinct actions: `verifyAndSave` (connection fields — always verifies, sets `verified_at`) and `updateFromFields` (from_name/from_addr only — direct save, `verified_at` untouched). The connection-field path structurally cannot save without a fresh verify (D-04 already guarantees this if edits reuse the same action).
**Warning signs:** Any `UPDATE smtp_configs` that writes `host/port/secure/username/password_*` without also writing `verified_at`.

### Pitfall 7: zod 4 API differences
**What goes wrong:** Training-data zod 3 idioms (`z.string().email()`) are deprecated/changed in zod 4 (installed: ^4.4).
**How to avoid:** Use zod 4 forms: `z.email()`, `z.coerce.number().int().min(1).max(65535)` for port. Quick check during execution: `npx tsc --noEmit` catches removed APIs.
**Warning signs:** Deprecation warnings or type errors on schema definition.

### Pitfall 8: Clerk development instance quirks on the staging URL
**What goes wrong:** Surprises when the shared staging URL runs on Clerk dev keys.
**Why it happens:** D-13 locks dev-instance keys for staging. Dev instances: 100-user cap, "development mode" banner on components, URL-based dev-browser session syncing (works on non-localhost domains without DNS config, which is why D-13 is viable). `[CITED: clerk.com/docs/guides/development/managing-environments; staging-alternatives doc]`
**How to avoid:** Nothing to build — set expectations in the phase verification notes; production instance is Phase 8. Confirm sign-in works on the staging domain as part of success criterion 6.
**Warning signs:** None blocking; the banner is expected.

### Pitfall 9: SSRF-ish probing via user-supplied SMTP host
**What goes wrong:** A user enters `host: 10.x.x.x` / `169.254.169.254` / `localhost` and uses verify's distinguishable errors to probe the VPS's internal network (open/closed port oracle).
**Why it happens:** BYO-SMTP means the server intentionally dials user-supplied host:port.
**How to avoid:** zod refinement rejecting loopback/link-local/RFC1918 literals for v1 (cheap), optionally resolve-then-check later. Also lightly rate-limit verify attempts per user (e.g., simple per-user counter — MVP-level). `[ASSUMED — standard SSRF hygiene; low blast radius here since only an SMTP handshake, but cheap to mitigate]`
**Warning signs:** Verify attempts against private-range hosts in logs.

## Code Examples

### 1. `proxy.ts` — Clerk middleware (Next 16 naming)

```ts
// Source: clerk.com/docs/reference/nextjs/clerk-middleware (matcher verbatim);
// protection pattern per Clerk's post-createRouteMatcher guidance
import { clerkMiddleware } from "@clerk/nextjs/server";

const PUBLIC_PATHS = [/^\/sign-in(\/.*)?$/, /^\/sign-up(\/.*)?$/];

export default clerkMiddleware(async (auth, req) => {
  const isPublic = PUBLIC_PATHS.some((p) => p.test(req.nextUrl.pathname));
  if (!isPublic) await auth.protect(); // redirects to NEXT_PUBLIC_CLERK_SIGN_IN_URL
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
```

### 2. Root layout — ClerkProvider inside `<body>`, shadcn theme

```tsx
// Source: clerk.com/docs/nextjs/getting-started/quickstart +
// clerk.com/docs/nextjs/guides/customizing-clerk/appearance-prop/themes
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        {/* Rule from Clerk docs: ClerkProvider goes INSIDE <body>, not around <html> */}
        <ClerkProvider appearance={{ theme: shadcn }}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
```

### 3. Dedicated sign-in page (D-10) + required env

```tsx
// Source: clerk.com/docs/nextjs/guides/development/custom-sign-in-or-up-page
// app/sign-in/[[...sign-in]]/page.tsx
import { SignIn } from "@clerk/nextjs";
export default function Page() {
  return <SignIn />;
}
// app/sign-up/[[...sign-up]]/page.tsx mirrors this with <SignUp />.
```

```bash
# .env (+ Coolify staging env; NEXT_PUBLIC_* also needed at build time — Pitfall 3)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…            # server-only, never a build arg
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

### 4. Verify with short timeouts + error classification + TLS auto-retry

```ts
// Timeout defaults verified against nodemailer.com/smtp (120s/30s/600s/30s → too slow for UX).
// Extend lib/core/send.ts SmtpConfig with optional fields rather than a second factory:
//   requireTLS?: boolean; connectionTimeout?: number; greetingTimeout?: number;
//   socketTimeout?: number; dnsTimeout?: number;
// (pure, additive change — keeps the single transport factory contract)

const ONBOARDING_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  dnsTimeout: 10_000,
};

export type VerifyErrorKind = "auth" | "connection" | "tls" | "unknown";

/** Map a nodemailer verify() rejection to a field-anchored classification (D-06). */
export function classifyVerifyError(err: {
  code?: string;
  message?: string;
}): { kind: VerifyErrorKind; field: "auth" | "hostPort" | "tlsMode" | "form" } {
  const msg = err.message ?? "";
  if (err.code === "EAUTH") return { kind: "auth", field: "auth" };
  // TLS-shaped: implicit-TLS handshake against a STARTTLS/plaintext port
  // surfaces as an SSL "wrong version number"-style ESOCKET error; STARTTLS
  // against an implicit-TLS port stalls at the greeting (greeting timeout).
  // [ASSUMED heuristic — pin down exactly with smtp-server fixtures in tests]
  if (/wrong version number|ssl|tls|handshake/i.test(msg)) {
    return { kind: "tls", field: "tlsMode" };
  }
  if (err.code === "ETIMEDOUT" && /greeting/i.test(msg)) {
    return { kind: "tls", field: "tlsMode" };
  }
  if (
    err.code === "EDNS" ||
    err.code === "ECONNECTION" ||
    err.code === "ETIMEDOUT" ||
    err.code === "ESOCKET"
  ) {
    return { kind: "connection", field: "hostPort" };
  }
  return { kind: "unknown", field: "form" };
}

/** D-04/D-05 core: verify; on a TLS-shaped failure, probe the alternate mode. */
export async function verifySmtp(input: SmtpFormValues): Promise<VerifyOutcome> {
  const attempt = async (secure: boolean) => {
    const transport = createSmtpTransport({
      host: input.host,
      port: input.port,
      secure,
      // STARTTLS mode must not silently downgrade to cleartext (PITFALLS #3):
      requireTLS: !secure,
      auth: { user: input.username, pass: input.password },
      ...ONBOARDING_TIMEOUTS,
    });
    try {
      await transport.verify();
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, err: err as { code?: string; message?: string } };
    } finally {
      transport.close(); // never leave the socket dangling
    }
  };

  const primary = await attempt(input.secure);
  if (primary.ok) return { ok: true };

  const classified = classifyVerifyError(primary.err);
  if (classified.kind === "tls") {
    const alternate = await attempt(!input.secure);
    if (alternate.ok) {
      // Do NOT save — surface the one-click switch suggestion (D-05).
      return { ok: false, suggestion: input.secure ? "starttls" : "implicit", ...classified, raw: primary.err.message ?? "" };
    }
  }
  return { ok: false, ...classified, raw: primary.err.message ?? "" };
}
```

### 5. DAL + DTO redaction (AUTH-02 / SMTP-04)

```ts
// lib/data/smtp.ts — every function REQUIRES userId; no unscoped query exists.
import { db } from "@/lib/db";
import { smtp_configs, type SmtpConfig } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export function getSmtpConfigForUser(userId: string) {
  return db.query.smtp_configs.findFirst({
    where: eq(smtp_configs.userId, userId),
  });
}

/** The ONLY shape that may cross to the client. Explicit picks — the encrypted
 *  triple cannot leak by omission. Password field is never present (D-07). */
export function toSmtpConfigDto(row: SmtpConfig) {
  return {
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    from_addr: row.from_addr,
    from_name: row.from_name,
    verified_at: row.verified_at,
  };
}

/** Single-row-per-user upsert (D-09). Requires the additive migration:
 *  CREATE UNIQUE INDEX smtp_configs_user_uq ON smtp_configs(user_id); */
export function upsertSmtpConfig(userId: string, values: PersistableConfig) {
  return db
    .insert(smtp_configs)
    .values({ userId, ...values, verified_at: sql`(unixepoch())` })
    .onConflictDoUpdate({ target: smtp_configs.userId, set: { ...values, verified_at: sql`(unixepoch())` } });
}
```

### 6. zod 4 form schema (shared client + server)

```ts
import { z } from "zod";

export const smtpFormSchema = z.object({
  host: z.string().min(1, "Host is required").trim(),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(), // explicit TLS mode — radio: "Implicit SSL (465)" | "STARTTLS (587)"
  username: z.string().min(1),
  password: z.string().min(1), // edit flow: optional + "leave blank to keep" (D-07)
  from_addr: z.email("Enter a valid from address"), // zod 4 top-level email
  from_name: z.string().trim().optional(),
});
export type SmtpFormValues = z.infer<typeof smtpFormSchema>;
```

### 7. Server Action skeleton (auth + typed returns)

```ts
// Source pattern: clerk.com/docs/reference/nextjs/app-router/auth
"use server";
import { auth } from "@clerk/nextjs/server";

export async function verifyAndSave(raw: unknown): Promise<ActionResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };

  const parsed = smtpFormSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: { kind: "validation", issues: parsed.error.issues } };

  const outcome = await verifySmtp(parsed.data);
  if (!outcome.ok) return { ok: false, error: outcome }; // classified, raw text in expandable detail (D-06)

  const { enc, iv, tag } = encrypt(parsed.data.password);
  await upsertSmtpConfig(userId, {
    host: parsed.data.host,
    port: parsed.data.port,
    secure: parsed.data.secure,
    username: parsed.data.username,
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: parsed.data.from_addr,
    from_name: parsed.data.from_name ?? null,
  });
  return { ok: true };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `middleware.ts` file convention | `proxy.ts` (middleware.ts silently ignored) | Next.js 16 | proxy.ts is mandatory; codemod exists (`npx @next/codemod@canary middleware-to-proxy`) |
| `createRouteMatcher()` route protection | Resource-based auth checks + thin `auth.protect()` middleware | @clerk/nextjs v7 docs | Plan tasks around DAL-level `userId` checks, not matcher lists |
| `@clerk/themes` for theming | `@clerk/ui` package, `shadcn` theme (`@clerk/ui/themes`) | Current Clerk docs | Use `@clerk/ui`; theme is Tailwind-4-compatible |
| `auth().protect()` sync call | `await auth()` (async) and `auth.protect()` | Clerk v6+ | Always `await auth()` in Server Components/Actions/Handlers |
| zod 3 `z.string().email()` | zod 4 `z.email()` top-level | zod 4 | Schema syntax in Code Example 6 |

**Deprecated/outdated:**
- `createRouteMatcher()` — deprecated by Clerk; do not introduce it.
- `@clerk/themes` as the shadcn-theming path — superseded by `@clerk/ui`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | TLS-shaped failure signatures: implicit-TLS-vs-STARTTLS mismatch surfaces as SSL "wrong version number" `ESOCKET` or greeting timeout | Code Example 4 / Pitfall classifier | D-05 auto-retry mis-triggers or misses; mitigate with `smtp-server` fixture tests in Wave 0 pinning exact codes/messages |
| A2 | Coolify passes marked env vars as Docker build args ("Build Variable" toggle) so `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` reaches `next build` | Pitfall 3 | Staging build fails; fallback: hardcode ARG default in Dockerfile per-environment or use Coolify docker-compose `build.args` |
| A3 | Clerk dev-instance session syncing works on the non-localhost staging URL with no extra dashboard config | Pitfall 8 | Staging sign-in broken; fallback per Clerk "staging alternatives" doc (separate dev instance for staging) |
| A4 | `NEXT_PUBLIC_*` inlining at `next build` (standard Next.js behavior) applies unchanged in Next 16 standalone output | Pitfall 3 | Same as A2 |
| A5 | SSRF/private-range host blocking is appropriate for v1 (no legit internal-SMTP user) | Pitfall 9 | A self-hosted user with internal SMTP is blocked; make the check a warn-not-block if that persona matters |

## Open Questions

1. **Test-send recipient default (D-03 "the user's own address")**
   - What we know: the step sends via the saved config; Clerk exposes the account's primary email via `currentUser()`.
   - What's unclear: prefill with the Clerk account email or the `from_addr`?
   - Recommendation: prefill with the Clerk primary email, editable field. Planner may decide otherwise; trivial either way.
2. **Unique index migration on `smtp_configs.user_id`**
   - What we know: schema lacks it; D-09 implies exactly one row per user; upsert needs a conflict target.
   - Recommendation: add the additive migration in this phase (drizzle-kit generate). Alternative is code-level read-then-write, which has a (minor) race.
3. **Compose `ports:` vs Coolify proxy**
   - What we know: the Phase 1 compose publishes `3000:3000`; Coolify normally fronts services with its own proxy/domain.
   - Recommendation: keep compose as-is for local, let Coolify manage exposure on the staging app; resolve on the actual instance during execution (Claude's-discretion area per CONTEXT).
4. **Where `/` lands**
   - Recommendation: `/` server-redirects to `/dashboard` (protected). Marketing/landing is Phase 9 territory.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | runtime | ✓ | 24.9.0 | — |
| npm | installs | ✓ | 11.12.1 | — |
| Docker | staging image build/local compose | ✓ | 28.1.1 (desktop) | — |
| Clerk account + dev-instance keys | AUTH-01..03 | ✗ (external — user must create the Clerk app and supply pk_test/sk_test) | — | none — blocks auth work until keys exist (5-min signup) |
| Coolify VPS access | success criterion 6 (staging deploy) | ✗ (external — user's VPS/Coolify credentials) | — | none for the deploy criterion; all other criteria testable locally |
| Real SMTP server creds | live verify/test-send manual checks | ✓ (user's own — `.env` from the CLI era exists) | — | `smtp-server` local fixture for automated tests |

**Missing dependencies with no fallback:**
- Clerk keys (user action, trivial) and Coolify access (user's infrastructure) — the planner should front-load a checkpoint asking Rob to create the Clerk application and confirm Coolify access before the deploy plan.

**Missing dependencies with fallback:**
- Automated SMTP behavior testing → `smtp-server` devDependency (approved above).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in `node:test` + tsx loader (established in Phase 1; no config file) |
| Config file | none — invoked per-file |
| Quick run command | `node --import tsx --test <file(s)>` |
| Full suite command | `node --import tsx --test $(find lib -name '*.test.ts')` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Sign-up/sign-in via Clerk works | manual-only (external IdP; prebuilt components) | — (manual: sign up on local + staging) | n/a — justified: Clerk-hosted flow, no unit surface |
| AUTH-02 | DAL queries scoped by userId; cross-tenant read impossible | unit/integration | `node --import tsx --test lib/data/smtp.test.ts` (two userIds against a temp `DATABASE_PATH` DB) | ❌ Wave 0 |
| AUTH-03 | Unauthed request to app route → redirect to /sign-in | integration/manual | `curl -sI http://localhost:3000/dashboard \| grep -i "location:.*sign-in"` against `next dev` | ❌ Wave 0 (script or manual gate) |
| SMTP-01 | Form fields validated (host/port/user/pass/from) | unit | `node --import tsx --test lib/smtp/schema.test.ts` | ❌ Wave 0 |
| SMTP-02 | `secure` stored explicitly; transport uses it verbatim | unit | existing `lib/core/send.test.ts` (partial) + schema test | ✅ partial / ❌ extension in Wave 0 |
| SMTP-03 | verify distinguishes auth vs host/port vs TLS failures; fails fast | unit/integration | `node --import tsx --test lib/smtp/errors.test.ts lib/smtp/verify.test.ts` (smtp-server fixtures: auth-reject, refused port, TLS mismatch) | ❌ Wave 0 |
| SMTP-04 | Password never in DTO/action results/logs | unit | `node --import tsx --test lib/data/dto.test.ts` (assert known password absent from `JSON.stringify` of every outward shape) + grep gate extended to `lib/smtp`/`lib/data` | ❌ Wave 0 |
| SMTP-05 | Save only after verify success; `verified_at` semantics incl. D-08 clearing | unit | `node --import tsx --test lib/smtp/actions.test.ts` (mock transport injected) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `node --import tsx --test <touched test files>` + `npx --no-install tsc --noEmit`
- **Per wave merge:** `node --import tsx --test $(find lib -name '*.test.ts')`
- **Phase gate:** full suite green + manual wizard walkthrough (local) + staging smoke (sign-in, verify, test-send) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `lib/smtp/schema.test.ts` — covers SMTP-01/SMTP-02 (zod schema)
- [ ] `lib/smtp/errors.test.ts` — covers SMTP-03 (classifier table-driven tests)
- [ ] `lib/smtp/verify.test.ts` — covers SMTP-03/D-05 (smtp-server fixtures; pins the TLS-shape assumption A1)
- [ ] `lib/data/smtp.test.ts` — covers AUTH-02 (cross-tenant isolation against temp DB)
- [ ] `lib/data/dto.test.ts` — covers SMTP-04 (redaction assertion)
- [ ] Framework install: `npm i -D smtp-server @types/smtp-server` (only new test infra needed)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Delegated entirely to Clerk (`clerkMiddleware` + prebuilt components); no custom credential handling for app login |
| V3 Session Management | yes | Clerk-managed sessions; server always re-derives identity via `await auth()` — never trusts client-supplied user IDs |
| V4 Access Control | yes | DAL functions require `userId`; DTO boundary; cross-tenant test (PITFALLS #13) |
| V5 Input Validation | yes | zod 4 server-side parse in every action; private-range host rejection (Pitfall 9) |
| V6 Cryptography | yes | `lib/crypto` AES-256-GCM (exists — never hand-roll more); `CREDENTIAL_ENC_KEY` fail-closed loader |
| V7 Error Handling & Logging | yes | Typed error results; raw error only in expandable detail (message text, no config); grep gate on secret-adjacent logging |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR on smtp_config (cross-tenant read/write) | Information disclosure / Tampering | Every query filtered by `auth().userId`; no by-id fetch without owner filter |
| Credential leak via logs / serialized errors / client responses | Information disclosure | DTO picker, typed action results, no transport `debug/logger`, redaction test |
| TLS downgrade (STARTTLS-capable server silently sends cleartext) | Information disclosure | `requireTLS: true` whenever `secure: false` |
| MITM via disabled cert checks | Spoofing / Info disclosure | Never default `tls.rejectUnauthorized: false` (nodemailer docs warn explicitly) |
| Internal-network probing via user-controlled host:port | Information disclosure | Reject loopback/link-local/RFC1918 hosts; per-user verify rate limit |
| Verify endpoint as SMTP auth-spam relay | Elevation/abuse | Same rate limit; short timeouts bound resource use |
| CSRF on mutations | Tampering | Server Actions carry Next.js built-in origin checks; no state-changing GETs |

## Sources

### Primary (HIGH confidence)
- clerk.com/docs/reference/nextjs/clerk-middleware — proxy.ts convention, matcher config, createRouteMatcher deprecation (fetched 2026-07-10)
- clerk.com/docs/nextjs/getting-started/quickstart — ClerkProvider placement, env vars, `@clerk/nextjs/server` auth
- clerk.com/docs/reference/nextjs/app-router/auth — `await auth()`, `auth.protect()` options, `redirectToSignIn()`
- clerk.com/docs/nextjs/guides/development/custom-sign-in-or-up-page — sign-in page path + env vars
- clerk.com/docs/nextjs/guides/customizing-clerk/appearance-prop/themes — `@clerk/ui` shadcn theme
- nodemailer.com/smtp — `secure`/`requireTLS` semantics, timeout defaults (120s/30s/600s/30s), verify() scope, rejectUnauthorized warning
- ui.shadcn.com/docs/forms/react-hook-form — form stack (react-hook-form + @hookform/resolvers + zod)
- npm registry via `npm view` (2026-07-10) — all version pins; postinstall checks
- Codebase: `lib/db/schema.ts`, `lib/db/client.ts`, `lib/crypto/*`, `lib/core/send.ts`, `Dockerfile`, `docker-compose.yml`, `package.json` — direct reads this session
- `.planning/research/STACK.md`, `PITFALLS.md` (2026-06-24, Context7-verified nodemailer/better-sqlite3 claims), `01-CONTEXT.md`, `02-CONTEXT.md`

### Secondary (MEDIUM confidence)
- github.com/clerk/javascript/issues/8302 — auth.protect() proxy redirect bug + env-var workaround (via WebSearch, official repo issue)
- nextjs.org/docs/messages/middleware-to-proxy + vercel/next.js discussion #84842 — middleware→proxy rename semantics (silently ignored old file)
- clerk.com/docs/guides/development/managing-environments — dev-instance 100-user cap, banner, cross-domain dev session syncing

### Tertiary (LOW confidence — flagged for validation)
- TLS-mismatch error signature specifics (A1) — training knowledge; pin with smtp-server fixtures
- Coolify build-variable mechanics (A2) — verify on the target instance during execution

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions and package legitimacy verified against the live registry + slopcheck this session
- Architecture: HIGH — Clerk/Next 16 patterns confirmed against current official docs; Phase 1 seams read directly from code
- Pitfalls: HIGH for proxy.ts/timeouts/env-inlining classes; MEDIUM for TLS-retry heuristics and Coolify specifics (explicitly logged as assumptions)

**Research date:** 2026-07-10
**Valid until:** ~2026-08-10 (Clerk v7 and Next 16 are moving; re-check the #8302 bug status and `@clerk/ui` version at planning time if delayed)
