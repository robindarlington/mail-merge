/**
 * Clerk auth middleware for all app routes (AUTH-03).
 *
 * NOTE ON THE FILE NAME: Next.js 16 renamed the middleware convention from
 * `middleware.ts` to `proxy.ts`. A `middleware.ts` file in a Next 16 project is
 * SILENTLY IGNORED — no warning, no route protection — so this file MUST be
 * named `proxy.ts` and live at the repo root (RESEARCH Pitfall 1).
 *
 * Every non-public path calls `auth.protect()`, which redirects unauthenticated
 * requests to NEXT_PUBLIC_CLERK_SIGN_IN_URL (=/sign-in). Setting that env var is
 * also the workaround for clerk/javascript#8302, where `auth.protect()` would
 * otherwise loop on the current URL instead of the sign-in page (Pitfall 2).
 *
 * This middleware only answers "signed in at all?". Per current Clerk guidance,
 * fine-grained per-user authorization (AUTH-02) lives in the Server Actions /
 * data-access layer, NOT here — do NOT reintroduce the deprecated route-matcher
 * helper that Clerk removed in v7 (resource-based checks replace it).
 */

import { clerkMiddleware } from "@clerk/nextjs/server";

// Public paths that must remain reachable without a session: the Clerk sign-in
// and sign-up catch-all pages (and their sub-routes).
const PUBLIC_PATHS = [/^\/sign-in(\/.*)?$/, /^\/sign-up(\/.*)?$/];

export default clerkMiddleware(async (auth, req) => {
  const isPublic = PUBLIC_PATHS.some((p) => p.test(req.nextUrl.pathname));
  if (!isPublic) await auth.protect(); // redirects to NEXT_PUBLIC_CLERK_SIGN_IN_URL
});

export const config = {
  matcher: [
    // Skip Next internals and static assets (incl. .csv uploads); run on everything else.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run on API + tRPC routes.
    "/(api|trpc)(.*)",
    // Clerk's internal handshake routes.
    "/__clerk/(.*)",
  ],
};
