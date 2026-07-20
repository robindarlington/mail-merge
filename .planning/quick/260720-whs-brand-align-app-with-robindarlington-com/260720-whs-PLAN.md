---
phase: quick-260720-whs
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/globals.css
  - app/layout.tsx
  - app/(marketing)/page.tsx
  - app/(marketing)/layout.tsx
  - .planning/phases/09-launch-collateral/09-UI-SPEC.md
autonomous: true
requirements: [WHS-01, WHS-02, WHS-03, WHS-04, WHS-05]
must_haves:
  truths:
    - "The app renders in a forest-green brand palette (green-tinted off-white in light, near-black green in dark) in BOTH themes, mapping robindarlington.com's tokens into the existing shadcn oklch variables"
    - "Campaign status colors (sent-green / failed-red badges) remain visually distinct from the new primary — status semantics stay obvious"
    - "All code/pre/code blocks across marketing pages AND the app render in JetBrains Mono, self-hosted at build time (no runtime Google Fonts request); UI text stays Geist"
    - "The landing hero shows a CSS-only merge-field typing animation ({{name}} → a concrete value with a blinking cursor); page stays a static RSC (no client JS)"
    - "The typing animation and marketing transitions are suppressed under prefers-reduced-motion: reduce (final state shown, no motion)"
    - "Interactive elements on marketing pages carry a 180ms ease transition; authed work surfaces (dashboard/compose) get NO added motion"
    - "09-UI-SPEC.md Color/Typography/Motion sections record the new brand contract, dated 2026-07-20, superseding the neutral-palette decision, citing robindarlington.com as the brand source"
    - "npm run build is green, npm test is green (385), scripts/smoke-public-routes.mjs prints SMOKE_PASS against a local server, and the work is pushed to origin master"
  artifacts:
    - path: "app/globals.css"
      provides: "Brand oklch tokens (:root + .dark), --font-mono wiring, typing keyframes, scoped marketing transitions"
      contains: "--font-mono"
    - path: "app/layout.tsx"
      provides: "JetBrains_Mono next/font import wired as --font-mono on <html>"
      contains: "JetBrains_Mono"
    - path: "app/(marketing)/page.tsx"
      provides: "CSS-only merge-field typing hero markup"
      contains: "brand-typed"
    - path: ".planning/phases/09-launch-collateral/09-UI-SPEC.md"
      provides: "Amended brand contract (color/typography/motion)"
      contains: "robindarlington.com"
  key_links:
    - from: "app/layout.tsx"
      to: "app/globals.css (--font-mono)"
      via: "next/font variable on <html> className resolved by @theme inline"
      pattern: "jetbrainsMono.variable"
    - from: "app/(marketing)/layout.tsx"
      to: "app/globals.css (.brand-marketing scope)"
      via: "wrapper class scoping 180ms transitions to marketing only"
      pattern: "brand-marketing"
    - from: "app/(marketing)/page.tsx"
      to: "app/globals.css (@keyframes brand-type / brand-caret)"
      via: "brand-typed class"
      pattern: "brand-typed"
---

<objective>
Brand-align the Mail Merge app with robindarlington.com — Rob's personal brand.
The app is a lead-gen/portfolio artifact for that brand, so it must visually
echo it: a forest-green palette, a mono face on code, and the site's signature
merge-field typing motion on the landing hero.

Four locked concerns, one plan:

1. **Palette** — map robindarlington.com's colors into the existing shadcn oklch
   variables in `app/globals.css` (both `:root` light and `.dark`). This
   supersedes the neutral-palette decision recorded in 09-UI-SPEC.
2. **Fonts** — KEEP Geist for UI; ADD self-hosted JetBrains Mono (`next/font`)
   for every code/`pre`/`code` block on marketing pages AND in the app.
3. **Typing hero** — a CSS-only `{{name}}` → concrete value typing animation with
   a blinking cursor on the landing hero; the page stays a static RSC.
4. **Motion** — 180ms ease transitions on marketing interactive elements only;
   authed surfaces untouched. All motion respects `prefers-reduced-motion`.

Then amend 09-UI-SPEC.md to record the new contract, verify (build + test + smoke
+ both-theme sanity), and push to origin master (triggers Coolify staging deploy).

Purpose: the deployed staging app becomes an on-brand portfolio piece.
Output: recoloured app, mono code, animated hero, amended design contract, pushed.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md

<interfaces>
Current token format in `app/globals.css` is oklch (radix-nova / neutral preset).
Match it EXACTLY — every replacement value below is already in oklch.

Existing font wiring (app/layout.tsx):
  const geist = Geist({subsets:['latin'],variable:'--font-sans'});
  <html className={cn("font-sans", geist.variable)}>
Existing @theme inline (globals.css) maps Tailwind utilities to CSS vars:
  --font-sans: var(--font-sans);   (this is why `font-sans` resolves to Geist)
  → add the mono twin the same way so `font-mono` resolves to JetBrains Mono.

Existing semantic token `--success` (light oklch(0.627 0.17 149),
dark oklch(0.696 0.17 162)) drives ALL sent/verified green (campaign status
badge, progress "sent" count, verify checks). `--destructive` drives failed/red.
Both MUST stay distinct from the new `--primary` — do NOT repoint them.

Marketing code blocks already use `font-mono` here (they will pick up JetBrains
Mono automatically once `--font-mono` is wired — no per-file edits needed):
  app/(marketing)/self-host/page.tsx  (4× pre.font-mono)
  app/(marketing)/agents/page.tsx     (pre + code.font-mono)
  app/(marketing)/docs/page.tsx       (bg-muted blocks)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Recolour tokens (brand palette, both themes) + wire self-hosted JetBrains Mono</name>
  <files>app/globals.css, app/layout.tsx</files>
  <read_first>
    - app/globals.css (full — you are overwriting token VALUES only, keep structure/order/@theme blocks intact)
    - app/layout.tsx (current Geist next/font wiring to mirror for mono)
  </read_first>
  <action>
    PART A — Light `:root` tokens. Replace ONLY these token values in globals.css
    `:root {}` block (leave every other line, comment, and the two `@theme`
    blocks untouched). Converted from the locked robindarlington.com hexes:

    | Token | New value | Source |
    |-------|-----------|--------|
    | --background | oklch(0.981 0.006 153.8) | #f6faf7 |
    | --primary | oklch(0.531 0.098 159.0) | #2f7d57 |
    | --secondary | oklch(0.954 0.014 155.0) | green-tinted neutral |
    | --muted | oklch(0.954 0.014 155.0) | green-tinted neutral |
    | --muted-foreground | oklch(0.463 0.024 159.0) | #4e5d54 secondary text |
    | --accent | oklch(0.954 0.027 145.4) | #e5f5e5 highlight |
    | --border | oklch(0.909 0.019 157.8) | #d7e5dc |
    | --input | oklch(0.909 0.019 157.8) | #d7e5dc |
    | --ring | oklch(0.531 0.098 159.0) | primary |
    | --sidebar | oklch(0.981 0.006 153.8) | #f6faf7 |
    | --sidebar-primary | oklch(0.531 0.098 159.0) | primary |
    | --sidebar-accent | oklch(0.954 0.027 145.4) | #e5f5e5 |
    | --sidebar-border | oklch(0.909 0.019 157.8) | #d7e5dc |
    | --sidebar-ring | oklch(0.531 0.098 159.0) | primary |

    KEEP light unchanged: --card, --popover (stay white oklch(1 0 0) for card
    lift), --foreground, --primary-foreground (white — AA-safe on #2f7d57),
    --secondary-foreground, --accent-foreground, --success, --destructive,
    --chart-*, --sidebar-foreground, --sidebar-primary-foreground,
    --sidebar-accent-foreground.

    PART B — Dark `.dark` tokens. Replace ONLY these values:

    | Token | New value | Source |
    |-------|-----------|--------|
    | --background | oklch(0.163 0.008 163.8) | #0b0f0d |
    | --card | oklch(0.205 0.010 163.0) | lifted green-dark |
    | --popover | oklch(0.205 0.010 163.0) | lifted green-dark |
    | --foreground | oklch(0.855 0.027 152.3) | #c3d5c7 |
    | --card-foreground | oklch(0.855 0.027 152.3) | #c3d5c7 |
    | --popover-foreground | oklch(0.855 0.027 152.3) | #c3d5c7 |
    | --primary | oklch(0.754 0.111 154.2) | #73c48f |
    | --primary-foreground | oklch(0.163 0.008 163.8) | dark text on primary (locked) |
    | --secondary | oklch(0.310 0.016 156.2) | #2a332d family |
    | --muted | oklch(0.310 0.016 156.2) | #2a332d family |
    | --muted-foreground | oklch(0.700 0.020 152.0) | dimmed brand text |
    | --accent | oklch(0.316 0.051 164.2) | #153a2b highlight |
    | --border | oklch(0.310 0.016 156.2) | #2a332d |
    | --input | oklch(0.310 0.016 156.2) | #2a332d |
    | --ring | oklch(0.754 0.111 154.2) | primary |
    | --sidebar | oklch(0.163 0.008 163.8) | #0b0f0d |
    | --sidebar-primary | oklch(0.754 0.111 154.2) | primary (was off-brand blue) |
    | --sidebar-primary-foreground | oklch(0.163 0.008 163.8) | dark |
    | --sidebar-accent | oklch(0.316 0.051 164.2) | #153a2b |
    | --sidebar-border | oklch(0.310 0.016 156.2) | #2a332d |
    | --sidebar-ring | oklch(0.754 0.111 154.2) | primary |

    KEEP dark unchanged: --secondary-foreground, --accent-foreground,
    --sidebar-foreground, --sidebar-accent-foreground (stay light), --success,
    --destructive, --chart-*.

    PART C — Status-colour distinctness check (locked requirement). Do NOT change
    --success or --destructive. Verify they still read as distinct from the new
    --primary: --success chroma (0.17) is markedly higher than --primary chroma
    (0.098 light / 0.111 dark), and --destructive is red (hue ~27) vs green (hue
    ~155). This keeps sent-green / failed-red badge semantics obvious against a
    forest-green primary. If (and only if) a build-output spot-check shows the
    "Completed" status badge green visually colliding with a primary button
    green, nudge --success lightness +0.03 — otherwise leave it exactly as is.

    PART D — Make body background theme-aware so BOTH brand backgrounds render.
    The unlayered `body {}` rule currently hardcodes `background: var(--color-background)`
    / `color: var(--color-foreground)` (light-only via the top @theme literals).
    Change those two declarations to `background: var(--background)` and
    `color: var(--foreground)` so the dark brand background applies too. Also
    update the top `@theme {}` block literals `--color-background: #ffffff` →
    `--color-background: #f6faf7` and `--color-foreground: #0a0a0a` (leave as-is;
    near-black is still the light foreground) so Tailwind's `bg-background` utility
    default matches the new light surface. Keep the `@theme inline` block untouched
    except for the mono addition in Part E.

    PART E — Wire self-hosted JetBrains Mono. In app/layout.tsx: extend the
    existing import to `import { Geist, JetBrains_Mono } from "next/font/google";`
    add `const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });`
    and add `jetbrainsMono.variable` to the `<html>` className cn() call alongside
    `geist.variable`. next/font self-hosts the woff2 at build → NO runtime Google
    request. Then in globals.css `@theme inline {}` add one line next to the
    existing `--font-sans: var(--font-sans);`:  `--font-mono: var(--font-mono);`
    so Tailwind's `font-mono` utility resolves to JetBrains Mono app-wide.
  </action>
  <verify>
    <automated>grep -q "0.531 0.098 159" app/globals.css && grep -q "0.163 0.008 163" app/globals.css && grep -q -- "--font-mono: var(--font-mono)" app/globals.css && grep -q "JetBrains_Mono" app/layout.tsx && grep -q "jetbrainsMono.variable" app/layout.tsx && grep -q "background: var(--background)" app/globals.css && grep -qc "0.627 0.17 149" app/globals.css && echo TASK1_OK</automated>
  </verify>
  <done>
    Light + dark brand oklch tokens applied; --success/--destructive unchanged
    and distinct; body uses theme-aware --background/--foreground; JetBrains Mono
    imported in layout and wired as --font-mono in @theme inline. `npm run build`
    compiles without CSS/TS error.
  </done>
</task>

<task type="auto">
  <name>Task 2: CSS-only merge-field typing hero + scoped 180ms marketing motion</name>
  <files>app/(marketing)/page.tsx, app/(marketing)/layout.tsx, app/globals.css</files>
  <read_first>
    - app/(marketing)/page.tsx (hero section, lines ~54-76 — insert the demo after the subhead <p>, before the CTA div; keep the file a server component, no "use client")
    - app/(marketing)/layout.tsx (the root <div className="flex min-h-svh flex-col"> — add the scope class here)
    - app/globals.css (append keyframes + scoped rules AFTER the existing @layer base block at the end)
  </read_first>
  <action>
    PART A — Typing hero markup (app/(marketing)/page.tsx). Inside the hero
    `<section>`, after the subhead paragraph and before the CTA `<div>`, add a
    decorative merge-field demo line that echoes robindarlington.com's typing
    motif: a mono line reading the literal token, an arrow, then the typed value.
    Structure it as a `<p>` with `className="font-mono text-sm text-muted-foreground"`
    containing, in order: a span with the literal text `{{name}}` (render the
    braces as a JS string expression so JSX does not treat them as an expression,
    e.g. the child is the string "{{name}}"); an `aria-hidden` arrow span with
    the text `→` and horizontal margins; and a `<span className="brand-typed text-primary">Sarah</span>`.
    The literal "Sarah" text MUST be present in the DOM (screen-reader legible);
    the animation only clips its width. No client JS, no state — the page stays a
    static RSC. Do NOT add "use client".

    PART B — Keyframes + typing styles (append to app/globals.css). Add:
    - `@keyframes brand-type { from { width: 0 } to { width: 5ch } }`  (5ch = the
      5 glyphs of "Sarah").
    - `@keyframes brand-caret { 0%, 49% { border-color: var(--primary) } 50%, 100% { border-color: transparent } }`
    - A `.brand-typed` rule: `display: inline-block; overflow: hidden; white-space: nowrap;
      vertical-align: bottom; width: 5ch; border-right: 2px solid var(--primary);`
      with `animation: brand-type 1.6s steps(5, end) 0.4s both, brand-caret 0.8s step-end infinite;`
      The `both` fill-mode leaves it resting at full width after typing.
    - Reduced-motion override: `@media (prefers-reduced-motion: reduce) { .brand-typed { animation: none; width: 5ch; border-right-color: transparent; } }`
      — final state, no motion, no caret.

    PART C — Scoped 180ms marketing transitions. On the marketing layout root
    `<div>` (app/(marketing)/layout.tsx) add the class `brand-marketing` to the
    existing className. Then append to app/globals.css a scoped rule so ONLY
    marketing interactive elements animate (authed dashboard/compose untouched —
    they are NOT descendants of .brand-marketing):
    `.brand-marketing a, .brand-marketing button, .brand-marketing [data-slot="card"] {
      transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease;
    }`
    and a reduced-motion guard:
    `@media (prefers-reduced-motion: reduce) { .brand-marketing a, .brand-marketing button, .brand-marketing [data-slot="card"] { transition: none; } }`
    Do NOT add any global/app-wide transition rule and do NOT touch (app) files.
  </action>
  <verify>
    <automated>grep -q "brand-typed" "app/(marketing)/page.tsx" && grep -q "@keyframes brand-type" app/globals.css && grep -q "@keyframes brand-caret" app/globals.css && grep -q "brand-marketing" "app/(marketing)/layout.tsx" && grep -q ".brand-marketing a" app/globals.css && grep -q "prefers-reduced-motion" app/globals.css && ! grep -rq "use client" "app/(marketing)/page.tsx" && echo TASK2_OK</automated>
  </verify>
  <done>
    Landing hero renders a CSS-only {{name}}→Sarah typing line with a blinking
    caret; page has no "use client" (stays RSC). Marketing interactive elements
    carry 180ms ease transitions scoped via .brand-marketing; no (app) file
    touched. Both the typing animation and marketing transitions collapse to
    final-state under prefers-reduced-motion.
  </done>
</task>

<task type="auto">
  <name>Task 3: Amend 09-UI-SPEC contract, verify (build + test + smoke + both-theme), push</name>
  <files>.planning/phases/09-launch-collateral/09-UI-SPEC.md</files>
  <read_first>
    - .planning/phases/09-launch-collateral/09-UI-SPEC.md (Color section ~113-131, Typography ~95-108, and add a Motion note; plus the Self-Resolved Decisions table D-2)
    - scripts/smoke-public-routes.mjs (top comment — it needs a running server; caller does `npm run build && npm run start` then runs the probe, optionally with SMOKE_BASE_URL)
  </read_first>
  <action>
    PART A — Amend 09-UI-SPEC.md to record the new brand contract (this supersedes
    the neutral-palette decision). Do NOT rewrite the whole doc; make targeted edits:
    - Add a dated note at the top of the `## Color` section: "AMENDED 2026-07-20 —
      brand-aligned with robindarlington.com. The neutral (baseColor: neutral)
      palette is superseded by a forest-green brand palette mapped into the
      existing oklch tokens in app/globals.css. Light: primary #2f7d57 on a
      #f6faf7 green-tinted background; dark: primary #73c48f on #0b0f0d. --success
      (sent) and --destructive (failed) are unchanged and remain distinct from
      primary so status semantics stay obvious." Update the Color table's
      Dominant/Accent rows to the new values (keep the one-accent discipline note).
    - Update the `## Typography` section Font note and Self-Resolved D-2: the
      earlier "no monospace font package" decision is superseded — JetBrains Mono
      is now self-hosted via next/font/google (built-in, no runtime request, not a
      forbidden runtime dependency) and drives all code/pre/code blocks; Geist
      stays for UI (explicit keep, no Inter swap).
    - Add a short `## Motion` subsection (or a note under Accessibility): marketing
      pages use 180ms ease transitions on interactive elements and a CSS-only
      merge-field typing hero; both respect prefers-reduced-motion; authed work
      surfaces get no added motion. Cite robindarlington.com as the brand source.

    PART B — Verify (run in order, all must be green):
    1. `npm run build` → exits 0 (both light + dark token sets present in the
       compiled CSS = both themes defined; confirm no CSS var/TS errors).
    2. `npm test` → all pass; confirm the suite count is 385 (locked expectation).
    3. Start a local production server and run the public-routes smoke:
       `npm run build` (if not already) then `npm run start` in the background,
       wait for it to listen, then `node scripts/smoke-public-routes.mjs`
       (or `SMOKE_BASE_URL=http://localhost:3000 node scripts/smoke-public-routes.mjs`)
       → output contains `SMOKE_PASS`. Stop the server afterward.
    4. Dark-mode sanity: confirm the compiled build output / globals.css contains
       BOTH the light (`:root` #f6faf7-derived) and dark (`.dark` #0b0f0d-derived)
       brand token sets — both themes defined.

    PART C — Push. `git add -A` the changed files, commit with message
    "feat(brand): align app with robindarlington.com — forest-green palette,
    JetBrains Mono, CSS typing hero, marketing motion", then
    `git push origin master` (triggers the Coolify staging deploy). Per repo
    memory: NO Claude co-author trailer; credit Robin Darlington.
  </action>
  <verify>
    <automated>grep -q "2026-07-20" .planning/phases/09-launch-collateral/09-UI-SPEC.md && grep -q "robindarlington.com" .planning/phases/09-launch-collateral/09-UI-SPEC.md && npm run build >/tmp/whs_build.log 2>&1 && npm test >/tmp/whs_test.log 2>&1 && grep -Eq "(^|[^0-9])385([^0-9]|$)" /tmp/whs_test.log && echo TASK3_OK</automated>
    <human-check>scripts/smoke-public-routes.mjs prints SMOKE_PASS against a running local server; both light and dark themes render on the staging deploy after push.</human-check>
  </verify>
  <done>
    09-UI-SPEC Color/Typography/Motion sections record the brand contract (dated
    2026-07-20, robindarlington.com cited, neutral palette superseded). Build
    green, test green (385), smoke SMOKE_PASS, both themes defined. Changes
    committed (no Claude trailer) and pushed to origin master.
  </done>
</task>

</tasks>

<verification>
- `npm run build` exits 0.
- `npm test` all pass (385).
- `node scripts/smoke-public-routes.mjs` → SMOKE_PASS against a local server.
- globals.css contains both `:root` (light #f6faf7-derived) and `.dark`
  (#0b0f0d-derived) brand token sets.
- No `"use client"` in app/(marketing)/page.tsx (hero stays a static RSC).
- No transition/motion added to any app/(app)/** file.
- Pushed to origin master.
</verification>

<success_criteria>
- App renders forest-green brand palette in both light and dark, mapped into the
  existing shadcn oklch tokens; sent-green/failed-red status badges stay distinct
  from the new primary.
- All code/pre/code blocks (marketing + app) render in self-hosted JetBrains Mono;
  UI stays Geist; no runtime Google Fonts request.
- Landing hero shows a CSS-only {{name}}→value typing animation with a blinking
  cursor; page is a static RSC; reduced-motion shows the final state.
- Marketing interactive elements have 180ms ease transitions; authed surfaces do
  not; all motion respects prefers-reduced-motion.
- 09-UI-SPEC amended (color/typography/motion, dated 2026-07-20, robindarlington.com
  cited). Build + test (385) + smoke green. Pushed to origin master.
</success_criteria>

<output>
Create `.planning/quick/260720-whs-brand-align-app-with-robindarlington-com/260720-whs-SUMMARY.md` when done.
</output>
