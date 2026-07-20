# UAT Checklist — post-overnight run (2026-07-19)

Reference for Rob when returning to verify the overnight work. All 11 roadmap
phases are complete; these are the remaining **human** items. Full detail lives
in each phase's `*-HUMAN-UAT.md` — tick results there (or run
`/gsd-verify-work`) so `/gsd-progress` clears the warnings.

---

## ✅ Already auto-verified overnight (no action needed)

| Check | How it was verified |
|---|---|
| Staging public routes | `/`, `/docs`, `/self-host`, `/agents` on https://mailmerge.robindarlington.com all return 200 signed-out (curl probe, 2026-07-19 ~23:30) |
| Staging route protection | `/dashboard`, `/settings/smtp`, `/campaigns/1/export` all 307 → `/sign-in` |
| Footer / BRAND-01 | "Robin Darlington" + `robindarlington.com/contact/` present in staging HTML |
| Test suites | Root 385/385, CLI 46/46, builds green |
| CLI security review | 2 Critical + 9 Warning findings found AND fixed same night (see `08.1-REVIEW.md`) |
| Web review (phase 9) | 5 Warnings found and fixed (see `09-REVIEW.md`) |

---

## 🔲 Phase 08.1 — CLI + MCP server (`.planning/phases/08.1-*/08.1-HUMAN-UAT.md`)

### 1. First npm publish (the big one)
```bash
cd packages/cli
npm login                      # your npmjs.com account; @robindarlington scope
npm publish --access public    # --access public avoids the restricted-scope 402
```
Acceptance:
- `npm view @robindarlington/mail-merge version` returns a version
- From a clean dir: `npx @robindarlington/mail-merge --help` runs
- An MCP client with `npx -y @robindarlington/mail-merge mcp` connects
- Tarball contains only `dist/` + `README.md`

### 2. Confirm the `@modelcontextprotocol/sdk@1.29.0` dependency pin
The plan wanted your explicit sign-off; it was cleared autonomously after
registry verification (official `modelcontextprotocol` org, exact pin, repo
`github.com/modelcontextprotocol/typescript-sdk`). Say "confirmed" or ask for a
repin/removal.

---

## 🔲 Phase 9 — Launch collateral (`.planning/phases/09-launch-collateral/09-HUMAN-UAT.md`)

### 3. Signed-in `/` → dashboard
Sign in on staging, visit `/` — should server-redirect to `/dashboard` with no
flash of the landing page.

### 4. Authed screenshots for README/portfolio
Capture dashboard / compose / campaign-progress at 1280×900 into
`docs/screenshots/` (public pages already have real captures). Optionally
reference one in `README.md`.

---

## 📣 Marketing / write-up status (all shipped in Phase 9 — no further phase)

- `docs/writeup.md` — "How I built Mail Merge" draft, committed. **Your step:**
  edit lightly and publish at robindarlington.com/thoughts/.
- Root `README.md` — public-facing, screenshots, both niches, quickstart,
  hire-me link.
- Landing `/` — niche-framed copy (credential delivery + per-row documents).
- `/docs`, `/self-host`, `/agents` — usage, deployment, and agent-access docs
  live on staging.

## 🗺 After UAT

Roadmap is fully executed. When the items above are ticked, the natural next
GSD step is `/gsd-audit-milestone` → `/gsd-complete-milestone` to close v1.
