# Phase 8 — Staging Deploy Notes (08-05)

**Verified:** 2026-07-17 · **Operator:** Robin Darlington · **Verdict: APPROVED (all 4 checkpoint tests pass)**
**Deployed commit:** `72c80e4` (master) · **Platform:** Coolify on VPS, Docker Compose build pack
**Staging URL:** the standing staging environment (unchanged)

## Deployment topology

- Coolify resource switched from **Dockerfile build pack → Docker Compose build pack**
  (compose file `/docker-compose.yml`). This was the pivotal fix of the checkpoint: the
  Dockerfile build pack deploys ONE container (the image's default CMD = web entrypoint),
  so the worker service never existed on staging and all sends sat queued forever. Under
  the compose build pack both services deploy; `docker ps` shows web + worker.
- Both containers healthy post-deploy; migrations applied by the web entrypoint
  (`[migrate] migrations applied`, six tables on disk); worker logged its readiness line
  (`worker ready`, after the in-process schema gate).
- Named volume `appdata` mounted at `/data` in both containers. The switch created a
  fresh volume; staging data was re-onboarded (old volume's data predates durable
  uploads and contained ghost rows — see Findings).

## Env / secret wiring (recorded as SET/absent only — no values)

| Var | State |
|-----|-------|
| `CREDENTIAL_ENC_KEY` | SET (runtime secret; never in image or build args) |
| `CLERK_SECRET_KEY` | SET (runtime secret) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + sign-in/up URL vars | SET (flow into image build via compose build args) |
| `DATABASE_PATH` / `UPLOADS_PATH` / `HOSTNAME` | hardcoded in compose (`/data/app.db`, `/data/uploads`, `0.0.0.0`) |
| `WAL_CHECKPOINT_MS` / `ORPHAN_SWEEP_MS` / `ATTACHMENT_ORPHAN_DAYS` | defaults apply (compose fallbacks) |
| `SEND_DELAY_MS` | temporarily 3000 for the interrupt test (operator may revert) |

Operator confirmed no secret values appear in web or worker logs.

## Stop Grace Period

- The Coolify per-app **Stop Grace Period setting exists on this VPS and was set to 300s**
  (Advanced → Operations) before the interrupt test. Compose-level `stop_grace_period`
  (5m worker / 1m web) is also in the file as belt-and-braces.

## Checkpoint test results

1. **Redeploy mid-send — PASS.** 24-recipient campaign (unique plus-addressed recipients),
   Coolify redeploy triggered at roughly a third sent. Campaign resumed automatically
   after the new containers came up and ran to completion: **24/24 sent, 0 failed, no
   recipient received a duplicate** (per-tag inbox verification), no "Interrupted" rows.
2. **Data survival — PASS.** SMTP config, lists, template rows, and full campaign history
   (including the interrupted campaign's per-recipient records) intact across the
   redeploy. (Noted product gap, not a persistence failure: no UI exists to browse
   saved templates — queued as follow-up work.)
3. **Maintenance routines — PASS.** Worker logged both routines on first idle poll:
   `wal checkpoint {busy:0, log:0, checkpointed:0}` and
   `attachment orphan sweep {deletedRows:0, deletedFiles:0, unlinkFailures:0}` —
   counts only, no filenames/paths/user data.
4. **Secrets — PASS.** See table above; nothing secret in logs.

## Residuals (documented, accepted)

- **Drain line not observable post-hoc:** `worker stopping — draining in-flight tick` is
  printed by the *outgoing* container; Coolify's log view shows the replacement
  container, so the line can't be read after the fact (a live `docker logs -f` during a
  redeploy would capture it). The exactly-once outcome (24/24, zero interrupted rows)
  is the effective evidence the drain window worked.
- **Secrets plaintext on VPS disk:** Coolify materializes env into
  `/data/coolify/.../.env` on the host — known platform residual (T-08-02 class),
  accepted for v1.
- **Backups:** any manual `app.db` copy must checkpoint first or copy all three files
  (`app.db`, `-wal`, `-shm`) together; automated backups remain deferred.

## Findings fixed during this checkpoint (platform-only failure modes)

1. **Root-owned legacy volume → SQLITE_READONLY:** pre-hardening deploys ran as root;
   named volumes keep ownership. Fixed: web entrypoint repairs `/data` ownership as
   root then drops to `node` via setpriv (`80192cf`).
2. **Ephemeral uploads:** the Dockerfile-build-pack era had no `UPLOADS_PATH` env, so
   CSVs went to the container filesystem and died on redeploy while their DB rows
   survived (ghost rows). Compose hardcodes `/data/uploads`; UI degrades gracefully on
   missing files (`5ecf658`).
3. **VPS build death on `chown -R /app`:** the recursive chown duplicated the full
   node_modules tree into a layer and the build died (exit 255). Fixed with
   `COPY --chown` (`aac3b9f`).
4. **Worker never deployed:** two stacked causes — the compose healthcheck +
   `service_healthy` gate did not survive platform compose handling (fixed: worker
   self-gates on the migrated schema in-process, `21c1f6f`), and the image-only worker
   service was unpullable/undeployable outside plain compose (fixed: identical build
   blocks on both services, `72c80e4`); ultimately the resource itself was on the
   Dockerfile build pack (fixed by the build-pack switch above).

**Grep anchors:** CREDENTIAL_ENC_KEY confirmed SET; grace period set; redeploy produced
no double-send.
