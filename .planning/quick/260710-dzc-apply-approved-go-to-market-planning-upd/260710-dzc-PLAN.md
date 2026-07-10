---
phase: quick
plan: 260710-dzc
type: execute
wave: 1
depends_on: []
files_modified:
  - LICENSE
  - .planning/PROJECT.md
  - .planning/REQUIREMENTS.md
  - .planning/ROADMAP.md
autonomous: true
requirements: [DEMO-01, BRAND-01, DNS-01, HIST-03]
must_haves:
  truths:
    - "Repo root has a standard MIT LICENSE for Robin Darlington, copyright 2026"
    - "PROJECT.md has a Business Context section framing the portfolio/lead-gen goal"
    - "REQUIREMENTS.md defines DEMO-01 (sandbox), BRAND-01 (attribution), a v2 DNS hint, and promotes CONV-01 to v1 as HIST-03"
    - "ROADMAP.md adds Phase 9 (Launch Collateral) and a per-phase staging-deploy criterion from Phase 2 onward"
    - "No Claude/AI attribution appears in any repo file, including commit trailers"
  artifacts:
    - path: "LICENSE"
      provides: "MIT license text, copyright 2026 Robin Darlington"
      contains: "MIT License"
    - path: ".planning/PROJECT.md"
      provides: "Business Context section + 3 new Key Decisions rows"
      contains: "Business Context"
    - path: ".planning/REQUIREMENTS.md"
      provides: "DEMO-01, BRAND-01, v2 DNS req, HIST-03, updated traceability + coverage"
      contains: "BRAND-01"
    - path: ".planning/ROADMAP.md"
      provides: "Phase 9 + staging criteria + updated progress table and execution order"
      contains: "Phase 9: Launch Collateral"
  key_links:
    - from: ".planning/REQUIREMENTS.md HIST-03"
      to: ".planning/ROADMAP.md Phase 6"
      via: "traceability table row + Phase 6 requirements list"
      pattern: "HIST-03"
    - from: ".planning/REQUIREMENTS.md BRAND-01"
      to: ".planning/ROADMAP.md Phase 9"
      via: "traceability table row mapping BRAND-01 to Phase 9"
      pattern: "BRAND-01"
---

<objective>
Apply 9 approved go-to-market planning updates (locked decisions from 2026-07-10) to the `.planning` docs and add an MIT LICENSE at the repo root. These updates reframe the project around its long-horizon purpose: a portfolio + client-pipeline artifact for Robin Darlington's freelance "spreadsheet-to-tool" work.

Purpose: Align planning docs with the approved business framing, add funnel/branding/DNS requirements, promote the send-report CSV into v1, add a launch-collateral phase, and license the code MIT (the code is the marketing).

Output: New `LICENSE` file; updated `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/REQUIREMENTS.md
@.planning/ROADMAP.md
@.planning/STATE.md
@./CLAUDE.md

CRITICAL constraints for this task:
- This is a docs/planning-file-only task plus a LICENSE file. NO application code changes.
- Preserve every file's existing content, section order, tone, and formatting conventions. These are surgical additions/edits, not rewrites.
- NO Claude/AI attribution anywhere in repo files, and the commit MUST NOT include any `Co-Authored-By` trailer. This is the user's explicit attribution preference for this repo.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add MIT LICENSE and update PROJECT.md (Business Context + Key Decisions)</name>
  <files>LICENSE, .planning/PROJECT.md</files>
  <action>
Create `LICENSE` at the repo root: standard MIT License text, copyright line `Copyright (c) 2026 Robin Darlington`. Use the canonical MIT template verbatim (permission notice + warranty disclaimer). No AI/Claude attribution.

Then edit `.planning/PROJECT.md`:

1. Add a new "Business Context" section (place it after "Core Value" and before "Requirements", so it frames the whole doc). Keep it short. State: the long-horizon goal is a portfolio + client-pipeline artifact for freelance "spreadsheet-to-tool" work (building/modifying/maintaining internal tools that replace manual spreadsheet+email processes). Target niches: IT admins/MSPs (credential delivery), per-row-document senders (payslips/certificates/invoices), and self-hosters (distribution). Revenue rungs: deploy-for-you, modify-for-you, and maintain-for-you retainers. Note that out-of-scope feature requests from users are consulting leads, not product gaps, and future phase decisions should be weighed against this framing.

2. In the Requirements > Active list, reference the sandbox/demo mode where sensible (e.g. add a bullet noting a zero-setup sandbox/demo transport is planned for v1.x as a funnel entry point — cross-references DEMO-01). Keep it consistent with existing bullet style.

3. Add three new rows to the Key Decisions table (append to the existing table, preserving the `| Decision | Rationale | Outcome |` columns):
   - MIT licensed — "The code is the marketing; self-hosters are distribution; revenue is services." Outcome column: "✓ Applied 2026-07-10".
   - Scope fences kept deliberately — plain-text-only, no tracking, no compliance machinery, 100–1,000 scale; these fences keep the product in the transactional/internal niche and exclude the cold-outreach/spam crowd, and define the boundary between product scope and billable custom work. Outcome: "— Standing".
   - Keep Clerk despite per-client-deploy friction — each single-tenant client deploy needs its own Clerk app; free tier covers it; revisit only if per-client deploys exceed ~5. Outcome: "— Standing (revisit at >5 deploys)".

4. Update the final "Last updated" line to `2026-07-10 (go-to-market planning updates applied)`.
  </action>
  <verify>
    <automated>test -f LICENSE && grep -q "MIT License" LICENSE && grep -q "Robin Darlington" LICENSE && grep -q "Business Context" .planning/PROJECT.md && grep -q "MIT licensed" .planning/PROJECT.md && grep -qi "clerk" .planning/PROJECT.md && grep -q "2026-07-10" .planning/PROJECT.md</automated>
  </verify>
  <done>LICENSE exists with MIT text + 2026 Robin Darlington copyright. PROJECT.md has a Business Context section, a v1.x sandbox reference in Active requirements, three new Key Decisions rows (MIT / scope fences / Clerk), and an updated Last-updated line. No AI attribution anywhere.</done>
</task>

<task type="auto">
  <name>Task 2: Update REQUIREMENTS.md (DEMO-01, BRAND-01, DNS v2, promote CONV-01 to HIST-03, traceability + coverage)</name>
  <files>.planning/REQUIREMENTS.md</files>
  <action>
Edit `.planning/REQUIREMENTS.md`, preserving existing checkbox/ID formatting conventions:

1. **Promote CONV-01 → HIST-03 (v1, Phase 6).** In the v1 "History & Records" category, add a new `- [ ] **HIST-03**: User can download a CSV of per-recipient results for a campaign (downloadable send report)`. Then REMOVE `CONV-01` from the v2 "Convenience" list, leaving a brief inline note that it was promoted to v1 as HIST-03 (e.g. keep CONV-02 and CONV-03, drop CONV-01's line and note the promotion).

2. **BRAND-01 (v1, UX-level).** Add a new v1 category "Branding & Attribution" (place near the end of the v1 categories, e.g. after Attachments) with: `- [ ] **BRAND-01**: The app UI displays attribution to Robin Darlington with a visible "hire me for tech support / custom work" link (footer or equivalent)`.

3. **DEMO-01 (v1.x / v2 — Funnel/Demo).** In the v2 Requirements section, add a new category "Funnel / Demo" with: `- **DEMO-01**: Sandbox/demo transport (Ethereal/Mailpit-backed) so a visitor can upload a CSV, compose, preview, and "send" to a captured inbox with zero SMTP setup (v1.x funnel entry point)`.

4. **DNS deliverability hint (v2).** In the v2 section, add a new category "Deliverability" with: `- **DNS-01**: Soft SPF/DKIM DNS check at SMTP onboarding, with a hint when the sending server isn't covered (doubles as a consulting hook)`.

5. **Traceability table.** Add two rows: `| HIST-03 | Phase 6 | Pending |` (place with the other HIST rows) and `| BRAND-01 | Phase 9 | Pending |` (place at the end). DEMO-01 and DNS-01 are v2/v1.x and are NOT added to the v1 traceability table.

6. **Coverage counts.** Update the "Coverage" block: v1 requirements total goes from 34 to 36 (added HIST-03 and BRAND-01); mapped-to-phases 36 (100%); unmapped 0.

7. Update the trailing "Last updated" line to `2026-07-10 (go-to-market updates: HIST-03 promotion, BRAND-01, DEMO-01, DNS-01)`.
  </action>
  <verify>
    <automated>grep -q "HIST-03" .planning/REQUIREMENTS.md && grep -q "BRAND-01" .planning/REQUIREMENTS.md && grep -q "DEMO-01" .planning/REQUIREMENTS.md && grep -q "DNS-01" .planning/REQUIREMENTS.md && grep -q "36 total" .planning/REQUIREMENTS.md && grep -q "| BRAND-01 | Phase 9 | Pending |" .planning/REQUIREMENTS.md && ! grep -q "CONV-01" .planning/REQUIREMENTS.md</automated>
  </verify>
  <done>REQUIREMENTS.md defines HIST-03 (v1, Phase 6), BRAND-01 (v1, Phase 9), DEMO-01 (v2/v1.x Funnel/Demo), DNS-01 (v2 Deliverability). CONV-01 removed from v2 with a promotion note. Traceability has HIST-03→Phase 6 and BRAND-01→Phase 9. Coverage reads 36 total / 36 mapped / 0 unmapped. Last-updated line refreshed.</done>
</task>

<task type="auto">
  <name>Task 3: Update ROADMAP.md (Phase 9, staging-deploy criteria, HIST-03 in Phase 6, progress table, execution order)</name>
  <files>.planning/ROADMAP.md</files>
  <action>
Edit `.planning/ROADMAP.md`, preserving existing structure, phase-detail format, and success-criteria numbering style:

1. **Staging deploy note (Overview).** Add a sentence to the Overview (or a short note directly under it) stating that the Phase-1 Compose skeleton is deployed as a standing staging environment early — during Phase 2 — and kept current per phase. This de-risks Phase 8 and provides an always-shareable demo URL.

2. **Per-phase staging success criterion.** For each of Phase 2 through Phase 9 (i.e. Phase 2 onward), append an additional Success Criterion: "The phase's slice is deployed to the standing staging URL on the VPS (Coolify) and works there." Do NOT add this to Phase 1 (already complete).

3. **HIST-03 into Phase 6.** In Phase 6's `**Requirements**:` line, append `HIST-03`. Add a Success Criterion to Phase 6 for the downloadable per-recipient results CSV (e.g. "User can download a CSV of per-recipient results for a completed campaign").

4. **New Phase 9: Launch Collateral.** Add a new phase entry (both in the top `## Phases` checklist and as a full `### Phase 9` detail block). Mode: mvp. Depends on: Phase 8. Requirements: BRAND-01. Scope: public README with screenshots; niche-framed landing-page copy (credential-delivery / per-row-documents framings); a "how it was built" write-up; and the UI footer attribution + hire-me link (BRAND-01 lands here). Write concrete, verifiable Success Criteria, e.g.: (1) A public README with at least one screenshot and run/deploy instructions exists at repo root; (2) Landing-page copy frames the two niches (credential delivery, per-row documents); (3) A "how it was built" write-up is published/committed; (4) The app UI footer shows Robin Darlington attribution and a working "hire me / custom work" link (satisfies BRAND-01); (5) The phase's slice is deployed to the standing staging URL and works there.

5. **Progress table + execution order.** Add a Phase 9 row to the Progress table (`0/TBD | Not started | -`). Update the Execution Order line to `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9`. Update the top-level `## Phases` checklist to include `- [ ] **Phase 9: Launch Collateral**`.
  </action>
  <verify>
    <automated>grep -q "Phase 9: Launch Collateral" .planning/ROADMAP.md && grep -q "HIST-03" .planning/ROADMAP.md && grep -q "standing staging URL" .planning/ROADMAP.md && grep -q "BRAND-01" .planning/ROADMAP.md && grep -q "8 → 9" .planning/ROADMAP.md && test $(grep -c "standing staging URL" .planning/ROADMAP.md) -ge 8</automated>
  </verify>
  <done>ROADMAP.md has a new Phase 9 (Launch Collateral, depends on Phase 8, mode mvp, BRAND-01) with concrete success criteria in both the checklist and detail sections; a staging note in the Overview; a per-phase staging-deploy criterion on Phases 2–9; HIST-03 added to Phase 6 requirements + a matching criterion; Phase 9 in the progress table; and execution order updated to end in 9.</done>
</task>

</tasks>

<threat_model>
Docs-only change plus a LICENSE file. No trust boundaries, no untrusted input, no code execution, no package installs. STRIDE register N/A. Only operational note: the commit must not carry a `Co-Authored-By`/AI-attribution trailer (user preference), which the executor enforces at commit time.
</threat_model>

<verification>
- `LICENSE` exists at repo root with MIT text and `Copyright (c) 2026 Robin Darlington`.
- PROJECT.md: Business Context section present; three new Key Decisions rows; sandbox referenced; Last-updated = 2026-07-10.
- REQUIREMENTS.md: HIST-03, BRAND-01, DEMO-01, DNS-01 present; CONV-01 removed; coverage 36 total; traceability rows added.
- ROADMAP.md: Phase 9 present; staging criteria on Phases 2–9; HIST-03 in Phase 6; execution order ends in 9; progress table has Phase 9.
- No file in the repo contains Claude/AI attribution.
</verification>

<success_criteria>
All 9 approved planning updates plus the MIT LICENSE are applied across the four files, existing formatting/tone preserved, and the eventual commit carries no AI attribution trailer.
</success_criteria>

<output>
Create `.planning/quick/260710-dzc-apply-approved-go-to-market-planning-upd/260710-dzc-SUMMARY.md` when done.
</output>
