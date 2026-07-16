import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // D-08: standalone output so the production image stays small and the two
  // entrypoints (web server.js, worker.js) can share one image.
  output: "standalone",
  // better-sqlite3 is a native module used by lib/db and the worker; keep it
  // external from the server bundle so its native bindings load at runtime.
  serverExternalPackages: ["better-sqlite3"],
  // Insurance that better-sqlite3's native .node binding is traced into the
  // standalone output folder even if nft misses it (RESEARCH A3 / Finding 3).
  outputFileTracingIncludes: {
    "*": ["node_modules/better-sqlite3/**/*"],
  },
  // Raised to fit one 10 MB attachment + multipart overhead (ATCH-01 uploads are
  // one-file-per-call). The platform limit is now the LOOSER of the two per-file
  // caps, so the app-level zod guards remain authoritative: CSV uploads still
  // enforce their own 4 MB via MAX_UPLOAD_BYTES (lib/csv/schema.ts, unchanged) and
  // attachments enforce 10 MB via MAX_ATTACHMENT_BYTES (lib/attachments/schema.ts).
  // Keeping the zod guards as the source of truth means each surface still rejects
  // an oversized file with a clear message BEFORE the platform body limit bites
  // silently (03-03 Pitfall 1 / T-3-DOS / T-07-06).
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
};

export default nextConfig;
