/**
 * lib/csv/storage — traversal-proof CSV persistence (V12 / T-3-TRAV).
 *
 * The ONLY module that writes uploaded CSV bytes to disk. It mirrors the
 * env-path resolver pattern from `lib/db/client.ts` (DATABASE_PATH → mkdirSync →
 * write) so the uploads directory is configured in exactly one place.
 *
 * SECURITY (V12 / T-3-TRAV): the on-disk file is named from
 * `crypto.randomUUID()`, never from the user-supplied filename, so a malicious
 * name like `../../etc/passwd` can never become a path component. The returned
 * `storagePath` is the RELATIVE `<uuid>.csv`; callers resolve it against
 * UPLOADS_DIR at read time (Pitfall 4 — absolute paths don't survive the
 * dev→container boundary).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Resolve the uploads directory. Prod: Coolify sets UPLOADS_PATH → /data/uploads;
 * native dev falls back to ./data/uploads (mirrors DATABASE_PATH in
 * lib/db/client.ts).
 */
const UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads");

/**
 * Persist `bytes` under an opaque `<uuid>.csv` name and return the RELATIVE
 * storage path. The user filename is never part of the path (traversal-proof).
 */
export function writeUpload(bytes: Buffer): { storagePath: string } {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${randomUUID()}.csv`; // opaque — user filename never in the path
  writeFileSync(resolve(UPLOADS_DIR, name), bytes);
  return { storagePath: name }; // store RELATIVE; resolve at read time (Pitfall 4)
}
