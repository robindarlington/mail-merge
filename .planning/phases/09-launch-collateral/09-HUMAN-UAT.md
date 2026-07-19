---
status: partial
phase: 09-launch-collateral
source: [09-VERIFICATION.md]
started: 2026-07-19T21:35:00Z
updated: 2026-07-19T21:35:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Staging public routes render signed-out
expected: `/`, `/docs`, `/self-host`, `/agents` return 200 signed-out on https://mailmerge.robindarlington.com; protected routes redirect to sign-in.
result: pass — verified automatically overnight (2026-07-19) via curl probe from the orchestrator: all four public routes 200, `/dashboard`, `/settings/smtp`, `/campaigns/1/export` all 307 → /sign-in. Footer attribution + https://robindarlington.com/contact/ present in served HTML. Spot-check in a browser at your leisure.

### 2. Signed-in `/` lands on dashboard (no landing flash)
expected: With a signed-in Clerk session, visiting https://mailmerge.robindarlington.com/ redirects server-side to /dashboard with no flash of the landing page.
result: [pending — needs your Clerk session]

### 3. Authed-screen screenshots for README/portfolio
expected: Capture dashboard / compose / campaign-progress screens into `docs/screenshots/` (1280×900 to match the public captures) and optionally reference one in README. The four public-page screenshots are already real captures.
result: [pending]

## Summary

total: 3
passed: 1
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
