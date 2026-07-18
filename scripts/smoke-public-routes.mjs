// Route-probe smoke test for the Phase 9 public marketing surface.
//
// This is the phase's automated end-to-end gate. It proves two things about the
// Plan 01 Clerk allowlist edit (proxy.ts PUBLIC_PATHS):
//
//   1. The four public routes ( / /docs /self-host /agents ) are reachable
//      signed-out and render (HTTP 200).
//   2. The authed routes ( /dashboard /settings/smtp /api/* ) are STILL
//      protected signed-out — they must NOT return a 200 render. This is a
//      positive regression test against threat T-09-01 (Elevation of
//      Privilege): it fails loudly if the allowlist ever over-exposes an
//      authenticated route.
//
// Dependency-free by design (threat T-09-SC): no imports beyond Node built-ins,
// uses the global `fetch` shipped with Node >= 18. The caller is responsible for
// starting a server (`npm run build && npm run start`) at the base URL first.
//
// Usage:
//   node scripts/smoke-public-routes.mjs
//   SMOKE_BASE_URL=http://localhost:3311 node scripts/smoke-public-routes.mjs

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);

// Public routes: MUST render 200 signed-out.
const PUBLIC_ROUTES = ["/", "/docs", "/self-host", "/agents"];

// Protected routes: signed-out these MUST NOT render (not a 200). A redirect to
// the sign-in page (3xx) or a 401/404/4xx is the expected, safe outcome.
const PROTECTED_ROUTES = ["/dashboard", "/settings/smtp", "/api/health"];

// A Clerk *development* instance bootstraps a per-browser cookie via a one-time
// "handshake" redirect to accounts.dev before it can read the signed-out state.
// This is a cookie bootstrap, NOT an auth denial (production pk_live instances
// skip it entirely). We only treat it as a browser-handshake — never as the
// sign-in auth gate — so a public route caught mid-handshake is not a failure.
function isClerkHandshake(location) {
  if (!location) return false;
  return (
    location.includes("clerk.accounts.dev") ||
    location.includes("/handshake") ||
    location.includes("__clerk_hs_reason")
  );
}

// The real auth gate: middleware redirects unauthenticated requests to the
// sign-in URL (proxy.ts -> NEXT_PUBLIC_CLERK_SIGN_IN_URL, default /sign-in).
function isSignInRedirect(location) {
  return !!location && /\/sign-in(\b|\/|\?)/.test(location);
}

// Probe one path with redirects disabled so we can inspect the raw status.
// Deliberately NOT sending a browser-navigation `accept: text/html` header:
// this is a route probe, so we want production-like semantics rather than the
// dev-instance browser handshake that a top-level document navigation triggers.
async function probe(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { redirect: "manual" });
    return {
      status: res.status,
      location: res.headers.get("location") || "",
      ok: true,
    };
  } catch (err) {
    return { status: 0, location: "", ok: false, error: err.message };
  }
}

async function main() {
  const failures = [];

  console.log(`smoke-public-routes: probing ${BASE}`);

  // Public routes must render (200). A dev-instance Clerk browser handshake is
  // tolerated (cookie bootstrap, not an auth denial) — but being redirected to
  // the sign-in gate would mean the route is NOT actually public: that fails.
  for (const path of PUBLIC_ROUTES) {
    const { status, location, ok, error } = await probe(path);
    const handshake = isClerkHandshake(location);
    const gated = isSignInRedirect(location);
    const pass = ok && !gated && (status === 200 || handshake);
    const note = gated
      ? "FAIL (redirected to sign-in — not public)"
      : pass
        ? handshake
          ? "OK (clerk dev handshake)"
          : "OK"
        : "FAIL (expected 200)";
    console.log(
      `  PUBLIC    ${path.padEnd(14)} -> ${ok ? status : `ERR ${error}`} ${note}`,
    );
    if (!pass) {
      failures.push(
        `${path} expected a public 200 render, got ${
          ok ? `${status}${gated ? " -> sign-in" : ""}` : `connection error: ${error}`
        }`,
      );
    }
  }

  // Protected routes must NOT render signed-out: the middleware must redirect
  // them to the sign-in gate, or the route must return 4xx. A 200 render — or a
  // bare Clerk handshake with no sign-in gate — would mean the allowlist
  // over-exposed an authed route (threat T-09-01) and fails.
  for (const path of PROTECTED_ROUTES) {
    const { status, location, ok, error } = await probe(path);
    const isBlocked = status === 401 || status === 403 || status >= 400;
    const pass = ok && status !== 200 && (isSignInRedirect(location) || isBlocked);
    console.log(
      `  PROTECTED ${path.padEnd(14)} -> ${ok ? status : `ERR ${error}`} ${
        pass ? "OK (gated, not 200)" : "FAIL (expected sign-in redirect or 4xx, not 200)"
      }`,
    );
    if (!pass) {
      failures.push(
        `${path} expected a sign-in redirect or 4xx (not a 200 render), got ${
          ok ? status : `connection error: ${error}`
        }`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE_FAIL: ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nSMOKE_PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error(`SMOKE_FAIL: unexpected error: ${err.message}`);
  process.exit(1);
});
