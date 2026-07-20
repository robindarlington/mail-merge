---
task: 260720-whs
title: Brand-align app with robindarlington.com
type: quick
completed: 2026-07-20
requirements: [WHS-01, WHS-02, WHS-03, WHS-04, WHS-05]
tasks_completed: 3
files_created: 0
files_modified: 4
commits:
  - b5b5b2c: brand palette tokens + JetBrains Mono
  - 7701f6c: CSS typing hero + scoped marketing motion
  - af92dee: 09-UI-SPEC brand contract amendment
key-files:
  modified:
    - app/globals.css
    - app/layout.tsx
    - app/(marketing)/page.tsx
    - app/(marketing)/layout.tsx
    - .planning/phases/09-launch-collateral/09-UI-SPEC.md
---

# Quick Task 260720-whs: Brand-align App with robindarlington.com Summary

Recoloured the Mail Merge app into robindarlington.com's forest-green palette (both
themes), self-hosted JetBrains Mono for all code blocks, added a CSS-only merge-field
typing hero, scoped 180ms marketing motion, and amended the 09-UI-SPEC brand contract —
build green, 385 tests green, smoke SMOKE_PASS.

## What Was Built

**Task 1 — Brand palette tokens + JetBrains Mono (`b5b5b2c`)**
- Mapped robindarlington.com's forest-green palette into the existing shadcn oklch
  tokens in `app/globals.css` for both `:root` (light, `#f6faf7` bg / `#2f7d57` primary)
  and `.dark` (`#0b0f0d` bg / `#73c48f` primary).
- `--success` (sent-green) and `--destructive` (failed-red) left unchanged and remain
  visually distinct from the new green primary (success chroma 0.17 vs primary ~0.10;
  destructive hue ~27 vs green ~155) — status badge semantics stay obvious.
- Made the unlayered `body {}` rule theme-aware (`var(--background)` / `var(--foreground)`)
  so the dark brand surface renders; updated the top `@theme` `--color-background` literal
  to `#f6faf7`.
- Wired self-hosted `JetBrains_Mono` via `next/font/google` in `app/layout.tsx`
  (`--font-mono` variable on `<html>`) and added `--font-mono: var(--font-mono)` to the
  `@theme inline` block so Tailwind's `font-mono` utility resolves to JetBrains Mono
  app-wide. `next/font` self-hosts the woff2 at build — no runtime Google Fonts request.

**Task 2 — CSS typing hero + scoped marketing motion (`7701f6c`)**
- Added a `{{name}} → Sarah` merge-field typing line to the landing hero
  (`app/(marketing)/page.tsx`). The literal "Sarah" is present in the DOM (screen-reader
  legible); the animation only clips its width. The page stays a static RSC — no
  `"use client"`, no state.
- Added `@keyframes brand-type` / `@keyframes brand-caret` and a `.brand-typed` rule
  (width clip + blinking caret) to `app/globals.css`, plus a `prefers-reduced-motion`
  override that shows the final state with no motion or caret.
- Scoped a 180ms ease transition to marketing interactive elements only via a
  `.brand-marketing` class on the marketing layout root — authed `(app)` surfaces are not
  descendants and are untouched. Reduced-motion guard collapses the transition too.

**Task 3 — 09-UI-SPEC amendment + verification (`af92dee`)**
- Amended `.planning/phases/09-launch-collateral/09-UI-SPEC.md`: dated (2026-07-20)
  Color-section note superseding the neutral palette; Typography note superseding the
  D-2 no-monospace decision (JetBrains Mono self-hosted, no runtime request); a new
  Motion section documenting the typing hero + marketing transitions + reduced-motion;
  the D-2 table row struck through and marked superseded. robindarlington.com cited as
  the brand source throughout.

## Verification

- `npm run build` → exit 0 (compiled + TypeScript clean; both light and dark brand token
  sets present in the compiled `.next` CSS).
- `npm test` → 385 tests, 385 pass, 0 fail.
- `node scripts/smoke-public-routes.mjs` against a local production server (port 3311) →
  `SMOKE_PASS` (4 public routes 200; 3 protected routes 307-gated).
- Both-theme sanity: `#f6faf7`-derived (`:root`) and `#0b0f0d`-derived (`.dark`) brand
  token sets confirmed in both `app/globals.css` and the compiled output.
- No `"use client"` in `app/(marketing)/page.tsx`; no motion added to any `app/(app)/**`
  file.

**Environment note:** the worktree had no `node_modules` and the build's page-data
collection hit `SQLITE_BUSY` on the shared DB from the copied `.env`. Resolved by
symlinking the parent repo's `node_modules` and pointing the build/test/server at a fresh
worktree-local `DATABASE_PATH` (`.smoke-data/app.db`, migrated fresh). Neither the symlink,
the fresh DB, nor the copied `.env` were committed (all gitignored / left untracked).

## Deviations from Plan

None affecting scope. The plan's Task 3 PART C (`git add -A` + single combined
`feat(brand)` commit + `git push origin master`) was adapted to the GSD executor
convention: each task committed atomically (code in Tasks 1–2, docs in Task 3), and the
push is deferred to the orchestrator per the worktree execution constraints. No Claude
co-author trailer (repo memory) — authored by Robin Darlington.

## Self-Check: PASSED

- FOUND: app/globals.css, app/layout.tsx, app/(marketing)/page.tsx,
  app/(marketing)/layout.tsx, .planning/phases/09-launch-collateral/09-UI-SPEC.md
- FOUND commits: b5b5b2c, 7701f6c, af92dee
