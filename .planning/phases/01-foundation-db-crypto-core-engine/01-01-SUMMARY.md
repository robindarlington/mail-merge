---
phase: 01-foundation-db-crypto-core-engine
plan: 01
subsystem: infra
tags: [nextjs, tailwind4, shadcn, drizzle-kit, better-sqlite3, typescript, scaffold]

# Dependency graph
requires: []
provides:
  - Single non-workspace Next.js 16 App Router app booting on the local tree (D-01)
  - Pinned dependency set installed per STACK.md (web, data, transport, queue, logging)
  - next.config.ts with output:'standalone' (D-08) verified via a real build
  - .nvmrc + engines node>=24 pin for better-sqlite3 native bindings + tsx
  - Committed .env.example enumerating all required env vars (CONCERNS.md gap closed)
  - drizzle.config.ts pointing at lib/db/schema.ts + ./drizzle out dir (consumed by 01-02/01-05)
  - npm scripts dev/build/start/worker/db:generate/db:migrate for downstream plans
  - shadcn/ui initialized (components.json, lib/utils.ts, Tailwind 4 CSS-first tokens)
affects: [01-02-db-schema, 01-03-crypto, 01-04-core-engine, 01-05-migration, phase-02-auth, phase-08-packaging]

# Tech tracking
tech-stack:
  added: [next@16.2.9, react@19.2.7, "@clerk/nextjs@7.5.9", drizzle-orm@0.45.2, drizzle-kit@0.31.10, better-sqlite3@12.11.1, nodemailer@9.0.1, papaparse@5.5.4, zod@4.4.3, p-queue@9.3.0, pino@10.3.1, plainjob@0.0.14, tsx@4.22.4, tailwindcss@4.3.1, "@tailwindcss/postcss", shadcn@4.12.0]
  patterns: ["Single-app lib/ layout (no workspaces, D-01)", "Tailwind 4 CSS-first config (@theme, no tailwind.config.js)", "Next standalone output as the web build target (D-08)"]

key-files:
  created: [.env.example, .nvmrc, next.config.ts, tsconfig.json, drizzle.config.ts, postcss.config.mjs, components.json, app/layout.tsx, app/page.tsx, app/globals.css, lib/utils.ts]
  modified: [package.json, package-lock.json, .gitignore]

key-decisions:
  - "plainjob pinned to ^0.0.14 (current published latest); STACK.md's ^1 range is not yet released on npm"
  - "Added @types/react, @types/react-dom, and @tailwindcss/postcss — required for the TS+Tailwind4 app to type-check and build but absent from the plan's install list"
  - "Preserved legacy send-credentials.ts + email-template.txt by committing them (lift source for plan 01-04); legacy CLI scripts kept under cli:dry/cli:test/cli:send"

patterns-established:
  - "Single-app, no-workspace structure: shared code lives in lib/, imported by web + worker (D-01/D-03)"
  - "Tailwind 4 CSS-first theming via @theme in app/globals.css; no JS Tailwind config file"
  - "All required env vars are documented in a committed .env.example with placeholders only (never real secrets)"

requirements-completed: []  # plan declares an infrastructure-scaffold note, not a tracked REQUIREMENTS.md ID

# Metrics
duration: 4min
completed: 2026-06-27
---

# Phase 1 Plan 01: Project Scaffold Summary

**Single non-workspace Next.js 16 App Router app that boots and type-checks with standalone output, pinned STACK.md deps installed, Tailwind 4 + shadcn/ui initialized, and committed .env.example/.nvmrc/drizzle.config.ts wiring the foundation every later Phase 1 plan builds on.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-06-27T20:58:38Z
- **Completed:** 2026-06-27T21:02:56Z
- **Tasks:** 2
- **Files modified:** 16

## Accomplishments
- Converted the legacy single-file CLI directory into a single Next.js 16 App Router + TypeScript + Tailwind 4 app in place, with NO workspace/monorepo config (D-01) — verified by the `node -e` gate that asserts the `workspaces` key is absent.
- Installed the full pinned dependency set from STACK.md (next 16.2.9, react 19.2.7, drizzle-orm 0.45.2, better-sqlite3 12.11.1, nodemailer 9.0.1, etc.); confirmed better-sqlite3 native bindings load and run WAL pragmas on Node 24.9.0.
- Established structural decisions D-08 (`output: 'standalone'`, verified by a real `next build` producing `.next/standalone`) and the Node pin (`.nvmrc` 24 + `engines.node >=24`).
- Closed the CONCERNS.md "no .env.example" gap with a committed template enumerating every required var (DATABASE_PATH, CREDENTIAL_ENC_KEY with generation guidance, Clerk keys, HOSTNAME/PORT, BYO-SMTP vars) using placeholders only — no real secrets leaked.
- Wired drizzle-kit (`drizzle.config.ts`) to the schema path plan 01-02 will author, and authored the five downstream npm scripts (dev/build/start/worker/db:generate/db:migrate).
- Ran shadcn/ui init (nova preset): `components.json`, `lib/utils.ts`, Tailwind 4 CSS-first token set in `app/globals.css`; booting static app shell type-checks with zero errors.

## Task Commits

Each task was committed atomically:

1. **Task 1: Initialize the single Next.js app, pin deps, write project config** — `fe4d7e1` (chore)
2. **Task 2: .env.example, drizzle.config.ts, shadcn init, booting app shell** — `6a7073c` (feat)

**Plan metadata:** committed separately with SUMMARY.md + STATE.md + ROADMAP.md.

## Files Created/Modified
- `package.json` - Single-app manifest: name/type/private preserved, engines node>=24, pinned deps, dev/build/start/worker/db:generate/db:migrate + cli:* scripts
- `package-lock.json` - Regenerated lockfile for the pinned + scaffold dependency tree
- `.nvmrc` - Node major pin (24) for better-sqlite3 native bindings + tsx
- `next.config.ts` - `output: 'standalone'` (D-08); better-sqlite3 marked serverExternal
- `tsconfig.json` - App Router defaults, `@/*` path alias to repo root (Next set jsx:react-jsx on build)
- `.gitignore` - Extended for /.next, /data, *.db sidecars, next-env.d.ts, *.tsbuildinfo
- `.env.example` - Committed enumeration of all required env vars (placeholders only)
- `drizzle.config.ts` - drizzle-kit sqlite config: schema ./lib/db/schema.ts, out ./drizzle, DATABASE_PATH
- `postcss.config.mjs` - Tailwind 4 PostCSS plugin wiring
- `components.json` - shadcn/ui config (nova preset)
- `lib/utils.ts` - shadcn `cn()` helper
- `app/layout.tsx` - Root layout importing globals.css, Geist font wired
- `app/page.tsx` - Static "Mail Merge — foundation" placeholder (no auth/data)
- `app/globals.css` - Tailwind 4 CSS-first config + shadcn design tokens
- `send-credentials.ts` / `email-template.txt` - Preserved legacy CLI (lift source for plan 01-04), now tracked in git

## Decisions Made
- **plainjob version range:** STACK.md's table lists `plainjob ^1`, but the package's current published latest is `0.0.14` (pre-1.0); the STACK.md Installation block itself uses an unpinned `plainjob`. Pinned to `^0.0.14` to match the documented "latest" intent. `plainjob` is the correct, registry-verified package named in the threat register (T-01-SC) — this is a version-range correction, not a package substitution. It is only consumed by the Phase 6 worker queue, not by this scaffold.
- **shadcn preset:** Used the `nova` preset (Lucide / Geist) non-interactively, the CLI's documented default base.
- **Preserving CLI assets in git:** Committed `send-credentials.ts` and `email-template.txt` (previously untracked) so the lift source for plan 01-04 is durably preserved, satisfying the "still exists on disk" acceptance criterion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected plainjob version range from `^1` to `^0.0.14`**
- **Found during:** Task 1 (dependency install)
- **Issue:** `npm install` failed with ETARGET — no `plainjob` version matches `^1`; the package's published latest is `0.0.14`.
- **Fix:** Verified via `npm view plainjob versions` that `plainjob` exists and is the correct registry package; pinned `package.json` to `^0.0.14` (its current latest), matching STACK.md's Installation block which uses an unpinned `plainjob`. No alternative/similarly-named package was substituted (Rule 3 exclusion respected — this is a version correction on the verified package, not a name swap).
- **Files modified:** package.json, package-lock.json
- **Verification:** `npm install` completes; `plainjob@0.0.14` present on disk.
- **Committed in:** fe4d7e1 (Task 1 commit)

**2. [Rule 3 - Blocking] Installed @types/react and @types/react-dom**
- **Found during:** Task 2 (type-check gate)
- **Issue:** `tsc --noEmit` failed with "Cannot find namespace 'React'" / missing JSX.IntrinsicElements — React type defs were not in the plan's install list, so the App Router shell could not type-check.
- **Fix:** Installed `@types/react@^19.2` and `@types/react-dom@^19.2` (official DefinitelyTyped, registry-verified).
- **Files modified:** package.json, package-lock.json
- **Verification:** `next build` runs TypeScript with zero errors; `tsc --noEmit` clean.
- **Committed in:** 6a7073c (Task 2 commit)

**3. [Rule 3 - Blocking] Installed @tailwindcss/postcss**
- **Found during:** Task 2 (PostCSS / build wiring)
- **Issue:** Tailwind 4 processes CSS through the separate `@tailwindcss/postcss` plugin package, which `postcss.config.mjs` references but shadcn init did not add; without it the CSS pipeline / `next build` would fail.
- **Fix:** Installed `@tailwindcss/postcss@^4.3` (official Tailwind package).
- **Files modified:** package.json, package-lock.json
- **Verification:** `next build` compiles and generates static pages successfully.
- **Committed in:** 6a7073c (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 3 - blocking)
**Impact on plan:** All three were required to satisfy the plan's own verification gates (install succeeds, `tsc --noEmit` clean, build produces standalone output). No scope creep — every added package is a registry-verified mainstream dependency directly implied by the chosen stack (Tailwind 4, React+TS, plainjob). The threat register (T-01-SC) explicitly clears these mainstream libs from any blocking-human gate.

## Issues Encountered
- shadcn `init` initially prompted interactively for a preset; resolved by passing `--preset nova` non-interactively. No functional impact.
- After shadcn init, `layout.tsx` and `globals.css` were rewritten by the CLI to wire the Geist font and full token set; this is expected shadcn behavior and was kept.

## User Setup Required
None for this plan to be complete. Note for later phases: developers must copy `.env.example` to `.env` and generate a `CREDENTIAL_ENC_KEY` via `openssl rand -base64 32` before running encryption-dependent code (Phase 2+). Clerk keys are placeholders until Phase 2.

## Next Phase Readiness
- Scaffold is ready for plan 01-02 (DB schema): `drizzle.config.ts` already points at `./lib/db/schema.ts`; `db:generate`/`db:migrate` scripts exist; better-sqlite3 native bindings verified on Node 24.
- `lib/` exists (currently only `lib/utils.ts`); plans 01-02/03/04 will add `lib/db`, `lib/crypto`, `lib/core`.
- `worker/index.ts` and `scripts/migrate.ts` are referenced by scripts but authored in later plans (01-05); the script entries exist now as designed.
- No blockers introduced.

## Self-Check: PASSED

All 16 claimed files exist on disk; both task commits (`fe4d7e1`, `6a7073c`) present in git history; `.next/standalone` output present (D-08 verified).

---
*Phase: 01-foundation-db-crypto-core-engine*
*Completed: 2026-06-27*
