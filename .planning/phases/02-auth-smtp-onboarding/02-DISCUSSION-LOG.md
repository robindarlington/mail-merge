# Phase 2: Auth + SMTP Onboarding - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-10
**Phase:** 2-Auth + SMTP Onboarding
**Areas discussed:** Onboarding flow shape, Verify & error UX, Editing saved config, Sign-in & app shell

---

## Onboarding Flow Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-step wizard | details → live verify → optional test-send; each step gates the next | ✓ |
| Single settings page | One form with Verify & Save; fewer screens, less guided | |

**User's choice:** Multi-step wizard

| Option | Description | Selected |
|--------|-------------|----------|
| Soft gate | Dashboard callout; app browsable without SMTP; only sending requires it | ✓ |
| Hard gate | Redirect to onboarding until SMTP verifies | |

**User's choice:** Soft gate
**Notes:** Keeps DEMO-01 (v2 sandbox mode) easy to add; aligns with funnel goal.

| Option | Description | Selected |
|--------|-------------|----------|
| Skippable test-send | Offered prominently, can skip; verify() already proved connection | ✓ |
| Required test-send | Onboarding incomplete until test email confirmed | |

**User's choice:** Skippable

---

## Verify & Error UX

| Option | Description | Selected |
|--------|-------------|----------|
| Verify-then-save, one action | Persists (encrypted) config only when verify() succeeds | ✓ |
| Separate test + save buttons | Repeat-testable Test button plus Save that re-verifies | |

**User's choice:** Verify-then-save, one action

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-retry & suggest | On TLS failure, try alternate mode; one-click switch if it works | ✓ |
| No auto-retry | Report failure; user flips the toggle | |

**User's choice:** Auto-retry & suggest (PITFALLS #3 mitigation as UX)

| Option | Description | Selected |
|--------|-------------|----------|
| Mapped, field-anchored | EAUTH→credentials fields, ETIMEDOUT→host/port, TLS→toggle; raw error expandable | ✓ |
| Plain banner with raw error | Friendly category line + raw nodemailer error | |

**User's choice:** Mapped, field-anchored

---

## Editing Saved Config

| Option | Description | Selected |
|--------|-------------|----------|
| Blank = keep current | Empty password field keeps stored password; typed value replaces | ✓ |
| Re-enter on every edit | Any edit requires retyping password | |

**User's choice:** Blank = keep current

| Option | Description | Selected |
|--------|-------------|----------|
| Only connection fields re-verify | host/port/secure/username/password changes clear verified_at until fresh verify | ✓ |
| Any change re-verifies | Every save re-runs verify() | |

**User's choice:** Only connection fields

| Option | Description | Selected |
|--------|-------------|----------|
| Edit/replace only (no delete) | Avoids FK breakage with campaigns; single profile has no delete use case | ✓ |
| Allow delete with confirm | Full credential removal for privacy-minded users | |

**User's choice:** Edit/replace only in v1

---

## Sign-in & App Shell

| Option | Description | Selected |
|--------|-------------|----------|
| Clerk prebuilt components | /sign-in + /sign-up with <SignIn/>/<SignUp/>, themed | ✓ |
| Custom forms via Clerk hooks | Hand-built shadcn forms; more control, more work | |

**User's choice:** Clerk prebuilt components

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar shell skeleton | shadcn sidebar, nav slots, user button, page container — built once here | ✓ |
| Minimal top-nav only | Slim header; later phases own their layouts | |

**User's choice:** Sidebar shell skeleton

| Option | Description | Selected |
|--------|-------------|----------|
| Basic footer now | "Built by Robin Darlington" + hire-me link (placeholder URL) from this phase on | ✓ |
| Wait for Phase 9 | Bare shell until Launch Collateral | |

**User's choice:** Basic footer now (BRAND-01 completes in Phase 9)

| Option | Description | Selected |
|--------|-------------|----------|
| Clerk dev instance on staging | Same test keys as local; prod instance in Phase 8 | ✓ |
| Separate Clerk prod instance now | Prod keys + custom domain already in Phase 2 | |

**User's choice:** Clerk dev instance on staging

---

## Claude's Discretion

- Route structure, middleware wiring, Server Actions vs Route Handlers, wizard components/copy, verify timeout, zod schemas
- Common-provider host presets (only if trivially cheap)
- Staging deploy mechanics (build on Phase 1 Compose skeleton)

## Deferred Ideas

- DEMO-01 sandbox transport (v2)
- CONV-03 multiple SMTP profiles (v2) — drives no-delete decision
- DNS-01 SPF/DKIM hints (v2)
- Production Clerk instance + custom domain (Phase 8)
