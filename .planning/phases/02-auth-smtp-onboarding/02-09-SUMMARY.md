---
phase: 02-auth-smtp-onboarding
plan: 09
subsystem: smtp-onboarding
tags: [smtp, edit-flow, human-verify, gap-closure, uat]
requires:
  - 02-08 blank-password edit merge (smtpEditFormSchema + applyVerifiedConfig merge branch)
provides:
  - Human confirmation that the CR-01 blank-password edit flow works end-to-end against a live SMTP server (local dev)
affects: []
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified: []
decisions:
  - "Checkpoint approved against local dev + a real SMTP server, as explicitly permitted by the plan's how-to-verify (staging OR local dev)"
metrics:
  tasks: 1
  files-modified: 0
  completed: 2026-07-12
---

# Phase 2 Plan 09: Live Blank-Password Edit Walkthrough Summary

Human-verify checkpoint for the CR-01 fix (02-08). The user ran the live wizard
walkthrough on **local dev against a real SMTP server** and confirmed both checks:

1. **Positive:** Editing only a connection field with the Password field left
   blank re-verified against the STORED password and saved — no "Password is
   required" error appeared. The full client → Server Action → verify → save
   path works with the server-side stored-password merge.
2. **Negative:** A wrong typed password still fails verify with an
   auth-anchored error (a typed value replaces the stored one).

User resume-signal: **"approved"** (2026-07-12).

## Follow-Up Flagged (environment, not code)

Immediately after this approval, the user reported that on the **production/staging
Coolify deployment** (Dockerfile build pack, freshly redeployed with new persistent
storage at `/data`), SMTP verification fails with a connection-classified error
("can't connect to SMTP server") even with valid details. This is a
`connection/hostPort` classification (DNS / TCP connect / timeout from inside the
container) — an infrastructure/egress issue on the VPS, not a regression in the
02-08 code path (which is confirmed working locally). Being diagnosed separately;
tracked as an open deployment concern against the 02-07 staging-deploy criteria.

## Deviations from Plan

None — checkpoint executed as written; local dev was an explicitly permitted venue.

## Self-Check: PASSED

- Human confirmation received ("approved") — verified.
- No code changes required or made — verified (files_modified: []).
