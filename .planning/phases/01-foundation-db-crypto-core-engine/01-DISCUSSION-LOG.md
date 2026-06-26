# Phase 1: Foundation — DB, Crypto, Core Engine - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-26
**Phase:** 1-Foundation — DB, Crypto, Core Engine
**Areas discussed:** Repo structure, Schema scope, Worker build/run, Dev environment

---

## Repo Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Single app + shared lib | One Next.js project; worker at /worker/index.ts; shared code in /lib (db, core, crypto); single lib/db opener enforces WAL/busy_timeout | ✓ |
| pnpm workspaces monorepo | packages/db, /core, /crypto + apps/web + apps/worker; strongest boundaries but workspace tooling overhead | |

**User's choice:** Single app + shared lib
**Notes:** Aligns with the user's earlier "keep the backend simple" directive. Boundary that matters (single SQLite opener) is preserved via a single lib/db module.

---

## Schema Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full v1 schema now | All entities defined up front in one Drizzle schema; evolve via migrations | ✓ |
| Incremental per phase | Define only what Phases 1–2 need; add tables per phase | |

**User's choice:** Full v1 schema now
**Notes:** The send_record state machine is the architectural linchpin; a coherent model up front avoids reshaping later. Unused tables are acceptable.

---

## Worker Build / Run

| Option | Description | Selected |
|--------|-------------|----------|
| tsx (dev) + esbuild bundle (prod) | Run TS directly in dev; bundle to single worker.js for Docker | ✓ |
| Node native TS strip-types | Node 22+ runs .ts directly (like the CLI); zero build but limits + newer | |
| tsc compile | Compile whole project to JS; conventional but heavier config | |

**User's choice:** tsx (dev) + esbuild bundle (prod)
**Notes:** Web built via Next.js standalone output; two entrypoints share one image.

---

## Dev Environment

| Option | Description | Selected |
|--------|-------------|----------|
| Native dev, Docker for deploy | next dev + tsx worker as two local processes; Compose skeleton only in Phase 1 | ✓ |
| Docker Compose from day one | Dev in containers for full parity; heavier loop | |

**User's choice:** Native dev, Docker for deploy
**Notes:** Phase 1 only needs the Compose skeleton (success criterion 4); full packaging is Phase 8.

---

## Claude's Discretion

- Encryption key via `CREDENTIAL_ENC_KEY` env var (`.env` dev / Coolify secret prod); helper fails loudly if absent/wrong length.
- Migrations via a `db:migrate` drizzle-kit script; migration files committed.
- Add committed `.env.example` (fixes a known CLI gap) and a Node version pin (`engines`/`.nvmrc`).
- `lib/core` generalizes `{{column}}` substitution, applies to subject + body, uses papaparse, and takes an explicit `secure` boolean.
- Concrete table/column names, indexes, and types left to the planner/executor within the agreed entity set.

## Deferred Ideas

- `plainjob` vs hand-rolled SQLite poller — Phase 6 (flagged for research).
- SSE vs polling for progress — Phase 6.
- WAL checkpointing, SIGTERM graceful shutdown, `stop_grace_period`, orphan cleanup — Phase 8.
- Per-row attachment storage layout + path-traversal guards — Phase 7 (table exists in schema now; handling later).
