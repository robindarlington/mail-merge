---
created: 2026-07-15
title: "Phase 6.1 review warnings (non-critical) — batch hardening pass"
area: smtp
source: 06.1-REVIEW.md (post-phase code review)
severity: warning
---

CR-01 (default-swap transaction committing after a 0-row target update, leaving
zero defaults) was fixed immediately (`fc4f2f4`). The remaining verified
findings from `06.1-REVIEW.md` queue here, joining the Phase 2/3/4 backlogs for
one consolidated resilience pass:

- **WR-01/WR-02** — `sendTestEmail` neither validates `toAddress` nor
  rate-limits, despite dialing verify + sending real mail per call —
  inconsistent with the T-061-08 rationale applied to create/update.
- **WR-03** — label-uniqueness and first-server-default reads happen BEFORE the
  up-to-15s verify dial; concurrent creates can yield duplicate labels or an
  uncaught `UNIQUE constraint failed` that breaks the never-rejects
  `ActionResult` contract. Re-check after the dial (or catch the constraint).
- **WR-04** — no client handler catches a REJECTED server action promise; worst
  case `ConfirmSendDialog.confirm()` leaves `submitting=true` in an
  undismissable modal (Cancel disabled, escape/outside prevented) — user
  trapped until reload. (Same spinner-lockup family as Phases 2–4 backlogs.)
- **WR-05** — delete-config-then-enqueue-draft slips past both the in-use guard
  and the summary check, queuing a campaign against a soft-deleted config.
  Re-resolve the config at enqueue time.
- **WR-06/WR-07** — stale `smtpConfigId` client state can display one server
  while proposing a deleted one; every confirm-dialog open leaks an orphaned
  draft campaign row (needs cleanup or reuse).
- Info findings: see 06.1-REVIEW.md.
