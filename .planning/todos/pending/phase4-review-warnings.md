---
created: 2026-07-13
title: "Phase 4 review warnings (non-critical) — batch hardening pass"
area: compose
source: 04-REVIEW.md (post-phase code review)
severity: warning
---

WR-01 (ownership spread order, both DALs) was fixed immediately (`a906a8f`). The
remaining verified findings from `04-REVIEW.md` queue here, joining the Phase
2/3 backlogs for one consolidated resilience pass before Phase 6 raises the
stakes:

- **WR-02/WR-03** — compose preview fetch has no `.catch`; `onSave` has no
  try/finally → silent failure / stuck "Saving…" button. (Same spinner-lockup
  family as Phase 2 WR-02/WR-08 and Phase 3 WR-01/02 — fix all in one pass.)
- **WR-04** — "Try selecting it again" retry copy can't work (effect keyed on
  `selectedId`; same-value re-select never re-fires). Add a retry button or key
  on a nonce.
- **WR-05** — null `emailColumn` renders "All N rows have a valid email
  address" though nothing was validated. Render a "couldn't determine the email
  column" state instead.
- **WR-06** — `raw: String(e.message)` ships server internals (incl. absolute
  uploads path in ENOENT) to the client. Map to generic copy server-side.
- **WR-07** — Enter with the `{{` popover open but zero matches falls through to
  form submit → template saved with dangling `{{partial`.
- **Info:** IN-01 empty-string storagePath escape hatch; IN-02 server columns
  unused in stepper; IN-03 unstable [] fallback re-fires step reset; IN-04
  vacuous T-3-TRAV test (`evil` never used); IN-05 duplicated
  `hasStructuralParseError`; IN-06 PopoverTitle typed h2 renders div.

**How to apply:** fold into the cross-phase hardening pass tracked in
[[phase3-review-warnings]] — the error-path/UX-lockup items across Phases 2–4
are one coherent work package.
