---
phase: 09-launch-collateral
plan: 02
subsystem: ui
tags: [nextjs, rsc, marketing, docs, mcp, cli, shadcn, tailwind]

# Dependency graph
requires:
  - phase: 09-launch-collateral (Plan 01)
    provides: marketing route group + layout (header + SiteFooter), PUBLIC_PATHS allowlist for /docs, /self-host, /agents
provides:
  - Public /docs step-by-step usage guide (seven-step run walkthrough + /agents pointer)
  - Public /self-host Docker/Coolify guide with a secret-safe env-var reference (build-vs-runtime split)
  - Public /agents CLI + MCP guide with verbatim npx + mcpServers snippets from the CLI README
affects: [09-launch-collateral Plan 03 (README points at these pages; snippet-parity diff), launch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Static RSC marketing page: no auth()/fetch, mx-auto max-w-3xl prose container, gap-8 py-12 section stack"
    - "Code-block idiom: <pre className='bg-muted rounded-md p-4 text-sm font-mono overflow-x-auto'> (no font package, D-2)"
    - "Verbatim snippet as string constant, diff-checked against packages/cli/README.md (anti-drift, T-09-05)"
    - "Secret-safe env docs: variable NAMES + openssl generator command only, never a key value (T-09-02)"

key-files:
  created:
    - "app/(marketing)/docs/page.tsx"
    - "app/(marketing)/self-host/page.tsx"
    - "app/(marketing)/agents/page.tsx"
  modified: []

key-decisions:
  - "Env-var docs grouped into two Cards (Runtime vs Build-time) to make the split visible at a glance"
  - "Verbatim CLI/MCP snippets held as named string constants (NPX_DRY_RUN, MCP_CONFIG) so JSX braces do not corrupt the JSON and parity is greppable"

patterns-established:
  - "Marketing prose page: max-w-3xl px-6 py-12 container, text-[28px] Display heading, text-xl section headings, neutral underlined inline links (D-5)"
  - "Secret-safe self-host documentation: names + generator command only"

requirements-completed: [BRAND-01]

# Metrics
duration: ~25min
completed: 2026-07-18
---

# Phase 9 Plan 02: Public content pages (docs / self-host / agents) Summary

**Three static RSC marketing pages — a seven-step /docs usage guide, a secret-safe /self-host env-var reference with the build-vs-runtime split, and an /agents CLI+MCP guide whose npx and mcpServers snippets are verbatim from the CLI README.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-18T22:18Z (approx)
- **Completed:** 2026-07-18T22:43Z
- **Tasks:** 3
- **Files modified:** 3 (all created)

## Accomplishments
- `/docs` renders the full onboard → upload → compose → preview → test → confirm → send walkthrough with the exact seven UI-SPEC step headings and a neutral pointer to `/agents`.
- `/self-host` documents the deployment shape and the complete env-var contract by NAME and SEMANTIC only, with a Runtime vs Build-time Card split and the `openssl rand -base64 32` generator — no real key or full `.env` ever rendered (T-09-02 mitigated).
- `/agents` presents the CLI quick-start and MCP client config with snippets copied verbatim from `packages/cli/README.md`; parity re-verified by grep against the README (T-09-05 mitigated).
- `npm run build` green after each task; all three routes prerender as static (`○`) content.

## Task Commits

Each task was committed atomically:

1. **Task 1: /docs — step-by-step usage guide** - `3494080` (feat)
2. **Task 2: /self-host — Docker/Coolify guide + env-var reference** - `7d796a4` (feat)
3. **Task 3: /agents — CLI + MCP instructions with verbatim snippets** - `0a3c6b8` (feat)

## Files Created/Modified
- `app/(marketing)/docs/page.tsx` - Static RSC seven-step usage guide + `/agents` pointer.
- `app/(marketing)/self-host/page.tsx` - Static RSC self-host guide; env vars by name/semantic in Runtime/Build-time Cards + openssl generator block.
- `app/(marketing)/agents/page.tsx` - Static RSC CLI + MCP guide with verbatim npx invocation and mcpServers JSON.

## Decisions Made
- Grouped env vars into two Cards (Runtime / Build-time) rather than one flat list so the inline-vs-runtime distinction is immediately legible; the section note and per-var detail both restate it.
- Held the verbatim CLI/MCP snippets as named string constants so JSX curly braces cannot mangle the JSON and so the exact strings (`"mcpServers"`, `"-y"`, package name, `mcp`) remain greppable for the parity gate.
- Used the shadcn `<Separator />` primitive (listed in the plan interfaces) for section dividers rather than a raw `<hr>`.

## Deviations from Plan
None - plan executed exactly as written. All three pages match the UI-SPEC Copywriting Contract, use only existing primitives/tokens (no new dependencies), and pass their per-task grep + build gates.

## Issues Encountered
- The Wave 1 marketing shell (`app/(marketing)/layout.tsx`, PUBLIC_PATHS allowlist) is not present in this worktree's base — Plan 01 runs in a sibling worktree and is merged by the orchestrator. The three pages build and prerender correctly on their own under the root layout; they inherit the header + SiteFooter (BRAND-01) once Plan 01's layout merges in. No action needed within this plan's scope.

## Security Notes
- **T-09-02 (Information Disclosure) mitigated:** `/self-host` renders only placeholder variable names and the `openssl rand -base64 32` generator command. Verified: `sk_(test|live)_…` and `pk_(test|live)_…` real-key patterns are absent; no full `.env` block is rendered.
- **T-09-05 (downstream Tampering) mitigated:** `/agents` npx command and mcpServers JSON are byte-for-byte matches of `packages/cli/README.md` (parity grep confirmed both directions).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All four public routes (landing from Plan 01 + these three) exist; Plan 03's README can now point at `/docs`, `/self-host`, and `/agents`, and its snippet-parity diff has concrete targets.
- Blocker/concern: none. Footer/header coverage (BRAND-01 across the public surface) depends on Plan 01's `(marketing)/layout.tsx` being merged — expected in the same wave sequence.

## Self-Check: PASSED

All three page files and the SUMMARY exist on disk; all three task commits (`3494080`, `7d796a4`, `0a3c6b8`) are present in git history.

---
*Phase: 09-launch-collateral*
*Completed: 2026-07-18*
