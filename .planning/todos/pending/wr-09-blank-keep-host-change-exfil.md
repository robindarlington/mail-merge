---
created: 2026-07-13
title: "WR-09: decide blank-keep + changed-host exfiltration posture (PRODUCT DECISION)"
area: smtp-onboarding
source: 02-REVIEW.md (delta re-review after CR-01 fix)
severity: warning
needs_user_decision: true
---

The 02-08 blank-keep merge introduces a capability: a hijacked session (attacker
who does NOT know the SMTP password) can submit an edit with `host` pointed at an
attacker-controlled server and password blank; the server decrypts the stored
credential and performs SMTP AUTH against that host — exfiltrating the plaintext
password.

**Tension:** the suggested mitigation (only allow blank-keep when host/username
match the stored row) would kill the exact CR-01 use case the user validated
(change host/port with password left blank). Options to weigh:

1. Accept the risk explicitly (session hijack already grants full account control;
   document as accepted residual risk).
2. Allow blank-keep for port/TLS-mode changes only; require password re-entry when
   HOST changes (middle ground — most of CR-01's convenience, closes the exfil path).
3. Require re-auth (Clerk step-up) before any connection-field edit.

Rob decides. Do not auto-fix — option 2/3 changes locked D-07/D-08 behavior.
