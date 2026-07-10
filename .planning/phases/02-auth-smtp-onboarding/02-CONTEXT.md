# Phase 2: Auth + SMTP Onboarding - Context

**Gathered:** 2026-07-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 delivers the first user-facing vertical slice: a user signs up / signs in via Clerk, and onboards their own SMTP server — proven functional by a live `transport.verify()` — with credentials AES-256-GCM-encrypted at rest and never exposed to the client or logs. It also establishes the app shell every later phase drops pages into, the `userId`-scoping convention for all data access, and the first staging deploy on the Coolify VPS (per the roadmap's staging-deploy criterion added 2026-07-10).

In scope: Clerk auth (sign-up/sign-in/redirect middleware), SMTP onboarding wizard (details → verify → optional test-send), encrypted credential persistence to the existing `smtp_configs` table, SMTP settings edit flow, app shell (sidebar nav + footer), staging deploy.

Out of scope (later phases): CSV upload (3), editor/preview (4), test-send of a batch (5), background sending (6), attachments (7), production hardening/prod Clerk instance (8), full launch collateral (9). Demo/sandbox mode (DEMO-01) is v2 — but the soft-gate decision below deliberately keeps the door open for it.
</domain>

<decisions>
## Implementation Decisions

### Onboarding Flow Shape
- **D-01:** Multi-step wizard: Step 1 server details form → Step 2 live verify with feedback → Step 3 optional test-send to the user's own address. Each step gates the next.
- **D-02:** Soft gate: after sign-up the user lands on the dashboard with a prominent "Set up your SMTP server" callout. The rest of the app (as it grows in later phases) stays browsable without SMTP; only sending features require a verified config. Rationale: keeps future demo/sandbox mode (DEMO-01, v2) easy to add and fits the funnel goal (see PROJECT.md Business Context).
- **D-03:** The final test-send-to-self step is offered prominently but skippable — the roadmap criterion says "offers"; `verify()` already proved the connection.

### Verify & Error UX
- **D-04:** Verify-then-save as ONE action: "Verify & continue" runs `transport.verify()` and only persists the encrypted config when it succeeds. An unverified config can never be saved (`verified_at` set on success).
- **D-05:** TLS auto-retry: on a TLS-shaped verify failure, silently retry the alternate mode (implicit SSL ↔ STARTTLS). If the alternate works, suggest a one-click switch ("Your server needs STARTTLS — switch and continue?"). Implements the PITFALLS #3 mitigation as UX.
- **D-06:** Errors are mapped and field-anchored: `EAUTH` → "username or password rejected" anchored to those fields; `ETIMEDOUT`/connection → "couldn't reach host:port" anchored to host/port; TLS errors → anchored to the TLS mode toggle. Raw SMTP/nodemailer error text available in an expandable detail for technical users.

### Editing Saved Config
- **D-07:** On edit, the password field renders blank with "leave blank to keep current password". The stored password is NEVER sent to the client (SMTP-04); a typed value replaces it.
- **D-08:** Re-verify is required only when connection fields change (host, port, secure, username, password) — this clears `verified_at` until a fresh verify passes. `from_name`/`from_addr` edits save directly without a verify round-trip.
- **D-09:** No delete in v1 — edit/replace only. Preserves FK integrity (`campaigns.smtp_config_id` will reference it for history) and there's no use case with a single profile (multiple profiles = v2 CONV-03).

### Sign-in & App Shell
- **D-10:** Clerk prebuilt components: dedicated `/sign-in` and `/sign-up` pages using `<SignIn/>`/`<SignUp/>`, themed to match Tailwind/shadcn. No custom auth forms.
- **D-11:** Build the shadcn sidebar shell skeleton in this phase: nav slots (Dashboard, SMTP Settings now; Campaigns/History appear in later phases), Clerk user button top-right, standard page container. Later phases drop pages into it.
- **D-12:** Basic attribution footer starts NOW: "Built by Robin Darlington" + hire-me/support link (placeholder URL the user will set later). BRAND-01 formally completes in Phase 9, but the staging URL is shareable from this phase on, so the funnel link exists from day one.
- **D-13:** Staging uses the Clerk development instance (same test keys as local dev). A production Clerk instance (custom domain, prod keys) is Phase 8 work.

### Claude's Discretion
- Route structure, middleware wiring, Server Actions vs Route Handlers split, exact wizard step components and copy, verify timeout duration, zod schemas — researcher/planner decide within the decisions above.
- Common-provider presets (e.g. Gmail/Outlook host autofill) were not requested — optional polish only if cheap.
- Exact staging deploy mechanics (Coolify app setup, env wiring) — follow the Phase 1 Compose skeleton; full hardening remains Phase 8.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project & Requirements
- `.planning/PROJECT.md` — constraints, Key Decisions (incl. 2026-07-10 additions: MIT/attribution, scope fences, Clerk revisit note), and the Business Context section that motivates the soft gate + footer decisions
- `.planning/REQUIREMENTS.md` — AUTH-01..03, SMTP-01..05 (this phase's requirement set); BRAND-01 (footer link, formally Phase 9)
- `.planning/ROADMAP.md` § Phase 2 — goal, success criteria (including the staging-deploy criterion)

### Research (authoritative for this phase)
- `.planning/research/STACK.md` — pinned versions: `@clerk/nextjs 7.5.x`, nodemailer 9.0.x, zod 4.4.x; Next.js App Router as persistent `node server.js`
- `.planning/research/PITFALLS.md` — #2 (secrets in logs/client), #3 (secure-from-port inference — fixed by explicit toggle + D-05 auto-retry), #4 (verify hang → short timeout), #13 (multi-tenant IDOR → per-row userId checks)
- `.planning/research/SUMMARY.md` § "Phase 2: Auth + SMTP Onboarding" — phase-level guidance (skip phase research; Clerk + nodemailer docs are authoritative)

### Prior Phase Decisions
- `.planning/phases/01-foundation-db-crypto-core-engine/01-CONTEXT.md` — D-01 single app, D-03 `lib/` layout, D-04 `lib/db` sole SQLite opener

### Existing Code (build on, don't duplicate)
- `lib/db/schema.ts` — `smtp_configs` table (encrypted triple, explicit `secure`, `verified_at`); userId scoping convention documented in header
- `lib/crypto/index.ts` + `lib/crypto/key.ts` — AES-256-GCM encrypt/decrypt, fail-closed `CREDENTIAL_ENC_KEY` loader
- `lib/core/send.ts` — verify + sendOne with explicit `secure` boolean and structured `{ ok, messageId } / { ok, error }` contract (reuse for wizard verify + test-send)
- `docker-compose.yml` / `Dockerfile` — Phase 1 Compose skeleton the staging deploy builds on

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `lib/core/send.ts` — the wizard's verify step and test-send step are thin wrappers over the existing verify/sendOne functions; no new transport code needed.
- `lib/crypto` — `encrypt()` output `{ enc, iv, tag }` maps 1:1 to `smtp_configs.password_enc/_iv/_tag`.
- `lib/db/client.ts` — sole SQLite opener; all Phase 2 data access goes through it (never open a second connection).
- shadcn/ui already initialized (`components.json`, Tailwind 4) — use shadcn primitives for wizard, forms, sidebar.

### Established Patterns
- Secret-safety is grep-enforced in `lib/core` (no logging of transport config) — Phase 2 server code must uphold the same rule: never log or serialize the password/decrypted config.
- Throw-early validation with human-readable messages — carry into zod form validation and API error mapping.

### Integration Points
- Clerk middleware wraps the App Router; every DB query adds `where userId = auth().userId` — this phase establishes the convention all later phases inherit (AUTH-02).
- `verified_at` is the flag later phases (5/6) check before allowing sends.
- The app shell built here receives CSV upload (Phase 3), editor (Phase 4), campaigns/history (Phase 6) pages.

</code_context>

<specifics>
## Specific Ideas

- The footer hire-me link uses a placeholder URL until Rob supplies the real one — make it a single config constant so Phase 9 finishes BRAND-01 by changing one value.
- Soft-gate callout on the dashboard should be the dominant element for a fresh account — the wizard is the "next action", not buried in settings.

</specifics>

<deferred>
## Deferred Ideas

- Demo/sandbox transport (DEMO-01) — v2; the soft gate keeps space for it.
- Multiple SMTP profiles per user (CONV-03) — v2; drives the no-delete decision.
- SPF/DKIM DNS hints at onboarding (DNS-01) — v2; noted as a consulting hook.
- Production Clerk instance + custom domain — Phase 8.
- Common-provider host presets — optional polish, only if trivially cheap during execution.

</deferred>

---

*Phase: 2-Auth + SMTP Onboarding*
*Context gathered: 2026-07-10*
