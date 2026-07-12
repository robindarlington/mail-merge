import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // D-08: standalone output so the production image stays small and the two
  // entrypoints (web server.js, worker.js) can share one image.
  output: "standalone",
  // better-sqlite3 is a native module used by lib/db and the worker; keep it
  // external from the server bundle so its native bindings load at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Kept in step with MAX_UPLOAD_BYTES (4 MB) so the zod upload guard rejects an
  // oversized CSV with a clear message BEFORE the platform body limit bites
  // silently (03-03 Pitfall 1 / T-3-DOS).
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
};

export default nextConfig;
