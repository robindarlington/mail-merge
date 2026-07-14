---
created: 2026-07-14
title: "Feature: multiple SMTP servers per account, selectable per send"
area: smtp-onboarding
source: user request (2026-07-14 session)
severity: feature
needs_user_decision: false
---

Rob wants to register several SMTP servers on one account and pick which one a
given send uses.

**Feasibility: high — the data model already half-supports it.**
`campaigns.smtp_config_id` (lib/db/schema.ts:114) already stamps a SPECIFIC
config onto each campaign at creation (lib/campaign/actions-core.ts:346), so
per-send selection is structurally in place. The only hard blocker is
`unique("smtp_configs_user_uq").on(t.userId)` (schema:64) — one config per user
— and `upsertSmtpConfig`'s onConflictDoUpdate(userId) which assumes it.

**Scope sketch:**
1. Migration: drop the userId unique constraint; add a `label` column (and
   probably `is_default`).
2. DAL (lib/data/smtp.ts): `listSmtpConfigsForUser`, get-by-id (userId-scoped,
   IDOR convention), create/update-by-id replacing the userId upsert; each
   config keeps its own verified_at gate.
3. Settings UI (/settings/smtp): single-form page becomes a list of servers
   with add/edit/verify/delete; verify flow unchanged per server.
4. Compose/confirm-send: server picker (defaults to the only/default config —
   zero extra clicks for single-server users); chosen id stamped on the
   campaign as today.
5. Send paths: test-send + Phase 6 worker must load the config by
   `campaign.smtp_config_id` (scoped to campaign.userId) instead of
   `getSmtpConfigForUser(userId)`. NOTE: the Phase 6 plans (06-02/06-04) say
   "load that user's config" — equivalent while the unique constraint exists,
   but load-by-campaign.smtp_config_id is the future-proof read; consider
   nudging execution that way.
6. Dashboard/compose readiness checks: "has at least one verified config".

**Security carry-overs:** per-config encrypted password (existing crypto),
redacted DTOs, WR-09 blank-keep decision applies per server row.

**Sizing:** small dedicated phase (or large quick task) — schema migration +
credential-flow surface says phase-with-plan rather than ad-hoc. Best slotted
after Phase 6 ships (worker read-path lands first, avoiding rework).
