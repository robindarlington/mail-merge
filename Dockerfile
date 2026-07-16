# syntax=docker/dockerfile:1
#
# Phase 8 HARDENED Dockerfile (D-07/D-08/D-10). ONE image, TWO entrypoints:
#   web    -> /app/web-entrypoint.sh  (node migrate.js && exec node server.js)
#   worker -> node worker.js          (compose `command` override, exec form)
#
# Hardening delivered here (RESEARCH Findings 2/3, Pitfalls 3/5/6, Security):
#   - esbuild-bundled worker.js/migrate.js run as direct `node` (no tsx/npx at
#     PID 1 — the SIGTERM path the phase-6 drain depends on now works)
#   - pruned `npm ci --omit=dev` prod-deps REPLACE the full node_modules copy
#     (no tsx/typescript/drizzle-kit in the runtime image)
#   - better-sqlite3 ABI pinned by using the SAME glibc base (node:24-bookworm-slim)
#     for BOTH build and run — NEVER Alpine/musl
#   - non-root USER node with a node-owned /data volume mount point
#   - the server-only Clerk secret + CREDENTIAL_ENC_KEY are NEVER a build ARG/ENV (no layer leak)

# Pin Node to the host/runtime ABI (24 LTS) so better-sqlite3 prebuilds match.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# better-sqlite3 compiles a native addon; ship build tooling for npm ci.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# --- deps (full, for the Next build + esbuild bundles) ----------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- prod-deps (pruned; carries the worker externals + web runtime deps) ----
# `--omit=dev` drops tsx/typescript/drizzle-kit/esbuild and other devDeps. This
# pruned tree is what the runtime image ships — it REPLACES the old full
# node_modules copy (RESEARCH Pitfall 5) and still contains better-sqlite3 (with
# its linux native binding) and pino, the two worker externals.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Clerk NEXT_PUBLIC_* values are client-safe and are INLINED into the client
# bundle by `next build` (Pitfall 3). They must therefore be present as ENV
# during the build RUN below — a runtime env var is too late. In Coolify these
# must be marked as BUILD VARIABLES (Assumption A2); the compose fallback passes
# them via web.build.args. These are BUILD-TIME ONLY.
# NOTE: the server-only Clerk secret key is intentionally ABSENT here — it must
# NEVER be a build ARG/ENV or baked into an image layer. It is injected at
# runtime via docker-compose web.environment (Pitfall 1/2, threat T-08-01).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_CLERK_SIGN_IN_URL=${NEXT_PUBLIC_CLERK_SIGN_IN_URL}
ENV NEXT_PUBLIC_CLERK_SIGN_UP_URL=${NEXT_PUBLIC_CLERK_SIGN_UP_URL}
ENV NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=${NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL}
ENV NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=${NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL}
# Next.js standalone output (next.config.ts: output: 'standalone'), then the
# esbuild worker + migrate bundles (single-file ESM, better-sqlite3/pino external).
RUN npm run build \
  && npm run build:worker \
  && npm run build:migrate

# --- runtime ----------------------------------------------------------------
# One runtime image used by BOTH the web and worker compose services. The
# service `command` chooses the entrypoint:
#   web    -> /app/web-entrypoint.sh  (default CMD: migrate then exec server.js)
#   worker -> node worker.js          (compose override, exec form)
FROM base AS runtime
ENV NODE_ENV=production
# Standalone server output (server.js + minimal traced tree) + static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Pruned prod dependencies — this is the ONLY node_modules the runtime ships
# (no dev toolchain). Overlaid on the standalone tree so the worker externals
# (better-sqlite3, pino) and every prod runtime dep are present and ABI-correct.
COPY --from=prod-deps /app/node_modules ./node_modules
# Bundled entrypoints + the SQL migrations migrate.js reads at runtime.
COPY --from=build /app/worker.js ./worker.js
COPY --from=build /app/migrate.js ./migrate.js
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/docker/web-entrypoint.sh ./web-entrypoint.sh
RUN chmod +x /app/web-entrypoint.sh \
  && mkdir -p /data \
  && chown -R node:node /data /app

# Non-root: run as the built-in `node` user; /data (the SQLite volume mount) is
# node-owned so a fresh named volume is writable without root.
USER node

EXPOSE 3000
# Default to the web entrypoint (exec-form so the script is PID 1 and its
# `exec node server.js` replaces it — clean SIGTERM path). The worker service
# overrides `command` with exec-form `node worker.js`.
CMD ["/app/web-entrypoint.sh"]
