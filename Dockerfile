# syntax=docker/dockerfile:1
#
# Phase 1 SKELETON Dockerfile (D-10). ONE image, TWO entrypoints (web + worker)
# selected by the compose service `command`. This builds the Next.js standalone
# output (D-08) and keeps better-sqlite3's native binding loadable at runtime.
#
# DEFERRED TO PHASE 8 (D-10 — production hardening, NOT built here):
#   - better-sqlite3 Node-ABI pin / explicit native rebuild in the runtime stage
#   - a dedicated esbuild/tsup worker bundle to a single worker.js (D-07)
#     (the skeleton runs the worker via `tsx worker/index.ts` instead)
#   - raised stop_grace_period, PID1/tini init, SIGTERM handling, WAL checkpoint
#   - non-root user, multi-arch, slimming/distroless runtime
# This stage layout is intentionally minimal; it is a topology skeleton, not a
# production-hardened build.

# Pin Node to the host/runtime ABI (24 LTS) so better-sqlite3 prebuilds match.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# better-sqlite3 compiles a native addon; ship build tooling for npm ci.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# --- deps -------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Clerk NEXT_PUBLIC_* values are client-safe and are INLINED into the client
# bundle by `next build` (Pitfall 3). They must therefore be present as ENV
# during the build RUN below — a runtime env var is too late. In Coolify these
# must be marked as BUILD VARIABLES (Assumption A2); the compose fallback passes
# them via web.build.args. These are BUILD-TIME ONLY.
# NOTE: CLERK_SECRET_KEY is intentionally ABSENT here — it is server-only and
# must NEVER be a build ARG/ENV or baked into an image layer. It is injected at
# runtime via docker-compose web.environment (Pitfall 1/2, threat T-2-BUILD).
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
# Next.js standalone output (next.config.ts: output: 'standalone').
RUN npm run build

# --- runtime ----------------------------------------------------------------
# One runtime image used by BOTH the web and worker compose services. The
# service `command` chooses the entrypoint:
#   web    -> node server.js   (Next.js standalone server)
#   worker -> tsx worker/index.ts  (Phase 8 swaps to a bundled worker.js, D-07)
FROM base AS runtime
ENV NODE_ENV=production
# Standalone server output + static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The worker entrypoint + its lib/ deps run via tsx in this skeleton.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/worker ./worker
COPY --from=build /app/lib ./lib
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json

EXPOSE 3000
# Default to the web entrypoint; the worker service overrides `command`.
CMD ["node", "server.js"]
