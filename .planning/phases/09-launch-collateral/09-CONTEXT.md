# Phase 9: Launch Collateral - Context

**Gathered:** 2026-07-18
**Status:** Ready for planning
**Mode:** Auto-generated (overnight autonomous run — grey areas resolved at Claude's discretion per user handoff 2026-07-18; decisions documented for morning review)

<domain>
## Phase Boundary

Package the project as a public, niche-framed portfolio + lead-generation artifact. Covers: root README with screenshot(s) and run/deploy instructions; public signed-out routes inside the same Next.js app (`/` landing, `/docs`, `/self-host`, `/agents`); a "how it was built" write-up draft (`docs/writeup.md`); site-wide footer attribution + hire-me link (BRAND-01); staging deploy of the slice. Out of scope: SEO tooling, analytics, blog infrastructure, separate marketing site, paid-tier/pricing pages, publishing the write-up (Rob does that manually at robindarlington.com/thoughts/).

</domain>

<decisions>
## Implementation Decisions

### Public routing (LOCKED 2026-07-15, from ROADMAP)
- Same Next.js app, not a separate site. Clerk middleware makes `/`, `/docs`, `/self-host`, `/agents` public (signed-out accessible). Signed-in users hitting `/` land on the dashboard (redirect in the landing route or middleware).
- Landing copy frames the two core niches: credential delivery, and per-row documents (payslips, certificates, invoices). Honest, plain-spoken, portfolio-grade — no marketing fluff, no fabricated testimonials/metrics.

### README + screenshots (auto-decided)
- Root README.md: what it is, screenshot(s), the two niches, feature list, quickstart (local dev), self-host pointer (links /self-host and docs), CLI/MCP pointer (links packages/cli README + /agents), license (MIT), attribution + hire-me link. Links the public repo https://github.com/robindarlington/mail-merge.
- Screenshots: captured against the local dev server via browser automation where possible (public landing + key authed screens if a dev session is attainable without interactive login; otherwise capture what is accessible and queue a "replace/add authed screenshots" item for Rob). Stored under `docs/screenshots/` and referenced with relative paths so they render on GitHub.

### Write-up (auto-decided)
- `docs/writeup.md` draft written for robindarlington.com/thoughts/: the story of generalizing a one-off credential-delivery CLI into a self-serve product, architecture choices (Next.js + SQLite + worker on Coolify, BYO SMTP), and the spec-driven AI-assisted build process. Draft quality: publishable with light editing; Rob publishes manually.

### Footer attribution (BRAND-01, auto-decided)
- One shared footer component rendered on all pages (public routes AND authed app pages, via root layout): "Built by Robin Darlington" + link to https://robindarlington.com/contact/ ("Hire me for custom work" or similar). Unobtrusive, consistent with existing UI (Tailwind + shadcn tokens).

### Deploy (auto-decided)
- Staging deploys from GitHub push via Coolify (compose build pack — per repo memory 2026-07-18). Push after completion; verifying the public routes on the standing staging URL is the human-verifiable checkpoint queued at phase end (consistent with prior phases).

### Claude's Discretion
Copy tone, page structure, screenshot selection, and component layout per existing conventions and the frontend-design skill. No new runtime dependencies.

</decisions>

<specifics>
## Specific Ideas

Success criteria from ROADMAP Phase 9 are authoritative (5 criteria). `/agents` documents the Phase 08.1 CLI + MCP server — its copy-paste examples should match packages/cli/README.md exactly (same npx commands, same MCP config snippet). The write-up and landing copy serve the freelance pipeline goal: the repo is the marketing; the audience is potential clients with spreadsheet-to-tool problems, not SaaS signups.

</specifics>

<deferred>
## Deferred Ideas

SEO/OG tooling beyond basic metadata, analytics, blog infra, pricing pages, publishing automation for the write-up, demo-video/GIF production (nice-to-have if time allows; not a success criterion).

</deferred>
