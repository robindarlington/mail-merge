---
phase: quick-260713-v0t
plan: 01
subsystem: compose-editor
tags: [merge-fields, autocomplete, caret, editor, EDIT-02, EDIT-03]
requires:
  - lib/core/fill.ts (existing merge engine)
  - lib/core/merge.ts (existing merge-gap engine)
  - components/ui/popover.tsx (Radix PopoverAnchor virtualRef)
provides:
  - Spaced/dotted/hyphenated merge-field column support in fill + merge + autocomplete
  - Caret-anchored suggestion popover (getCaretRect mirror-div, zero new deps)
affects:
  - components/compose/compose-editor.tsx
  - components/compose/merge-field-menu.tsx
tech-stack:
  added: []
  patterns:
    - "Hand-rolled mirror-div caret geometry (no new npm dependency)"
    - "Radix Popover virtualRef anchored to a ref-backed virtual measurable"
key-files:
  created:
    - components/compose/caret-coords.ts
  modified:
    - lib/core/fill.ts
    - lib/core/merge.ts
    - lib/core/fill.test.ts
    - lib/core/merge.test.ts
    - components/compose/compose-editor.tsx
    - components/compose/merge-field-menu.tsx
decisions:
  - "TOKEN grammar widened to /\\{\\{([^{}]+)\\}\\}/g in both fill.ts and merge.ts (kept identical, un-shared — files stay independently pure)"
  - "Captured group trimmed at lookup/dedup time so {{ First Name }} and {{First Name}} resolve to one key"
  - "Caret rect held in a ref (not state) feeding a virtual anchor — avoids extra renders"
metrics:
  tasks: 2
  files_created: 1
  files_modified: 6
  tests: 189 pass / 0 fail
  completed: 2026-07-13
---

# Quick Task 260713-v0t: Fix Compose-Editor Bugs (Spaced Merge Fields + Caret Popover) Summary

Fixed two compose-editor bugs: merge fields with spaces in the column name (e.g. `{{First Name}}`) now substitute and autocomplete correctly, and the `{{`-suggestion popover now renders at the caret pixel position instead of below the "Merge fields" chip row — both with zero new npm dependencies.

## What Was Built

### Task 1 — Widen token grammar to allow spaces (commit 6f63a4c)
- Replaced the `[\w.-]+` token grammar with `/\{\{([^{}]+)\}\}/g` in **both** `lib/core/fill.ts` and `lib/core/merge.ts`, keeping the two definitions identical and un-shared (the files stay independently pure — no import added between them).
- `fill()` now trims the captured group before the row lookup and returns the full original `match` on a miss, preserving the documented pass-through rule including original inner whitespace.
- `extractTokens()` adds the trimmed capture to the seen set, so `{{ First Name }}` and `{{First Name}}` dedup to one key; `analyzeMerge` consumes its output unchanged.
- Widened the compose-editor autocomplete detector from `/\{\{\s*([\w.-]*)$/` to `/\{\{([^{}]*)$/`, so typing a space inside a partial (`{{First N`) keeps the popover open and filtering. `start` math unchanged.
- Added spaced-column test cases to `fill.test.ts` (match, trimmed match, unknown pass-through) and `merge.test.ts` (dedup across spacing, empty classification, unknown classification).

### Task 2 — Anchor suggestion popover to the caret (commit f0083b8)
- Created `components/compose/caret-coords.ts` exporting `getCaretRect(el, caret)`. Hand-rolled mirror-div technique: an off-screen div copies the field's computed font/padding/border/box-sizing/width styles, renders text-before-caret plus a zero-width marker span, reads the span's offset, adds the field's viewport rect, subtracts scroll, and removes the div. Handles `<input>` (`white-space: pre`, fixed height, `scrollLeft`) and `<textarea>` (`pre-wrap` wrapping, `scrollTop`).
- Wired `compose-editor.tsx`: a `caretRect` ref (not state) updated in `detectAutocomplete`, plus a stable `caretAnchorRef` exposing a DOMRect-like `getBoundingClientRect()` reading `caretRect.current`. Added `onScroll` handlers on the subject Input and body Textarea to re-anchor when the field scrolls.
- Updated `merge-field-menu.tsx`: removed the `<PopoverAnchor asChild>` wrapper (chips render directly, unchanged position), added a self-closing `<PopoverAnchor virtualRef={caretAnchorRef} />`, and added the `caretAnchorRef` prop. Popover content, mousedown-select, Escape, and Enter behaviour left intact.

## Verification

- `npm test` — 189 pass / 0 fail (includes new spaced-column cases for `fill`, `extractTokens`, `analyzeMerge`). TDD RED confirmed before GREEN.
- `npx tsc --noEmit` — clean.
- `npm run build` (next build) — compiled successfully, all routes generated.
- `git diff package.json package-lock.json` — empty (zero-new-dependency constraint held).
- **Browser check — PENDING (orchestrator-driven):** `npm run dev`, open compose editor, pick a recipient list, type `{{` in subject and message: popover appears at the caret (not below chips) and follows the caret/scroll; a space inside a spaced field name keeps it filtering; Escape closes, Enter picks first match, click inserts without blurring. No component-test harness exists for caret geometry, so this must be verified visually.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- FOUND: components/compose/caret-coords.ts
- FOUND: lib/core/fill.ts, lib/core/merge.ts (grammar widened)
- FOUND: commit 6f63a4c (Task 1)
- FOUND: commit f0083b8 (Task 2)
