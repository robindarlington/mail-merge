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

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
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

/**
 * Read a previously-stored CSV back off disk, returning its raw bytes.
 *
 * SECURITY (V12 / T-4-TRAVERSAL): `storagePath` is resolved against UPLOADS_DIR
 * and the result is prefix-checked, so a traversal name like `../../etc/passwd`
 * (which would resolve outside the dir) is rejected before any read.
 *
 * IDOR (Pitfall 3 / T-4-IDOR-READ): `storagePath` MUST originate from a
 * userId-scoped `getRecipientSetForUser` row — NEVER from the client. This
 * function trusts its caller to have already tenant-scoped the path; it only
 * enforces the traversal boundary, not ownership.
 */
export function readUpload(storagePath: string): Buffer {
  const full = resolve(UPLOADS_DIR, storagePath);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)) {
    throw new Error("resolved upload path escaped the uploads directory");
  }
  return readFileSync(full);
}

/**
 * Delete a previously-stored CSV file. Best-effort: a MISSING file (ENOENT) is
 * tolerated silently so a caller can treat the unlink as idempotent (the DB row
 * is the source of truth; a disk-only leftover is harmless — mirrors the worker's
 * maintenance sweep discipline).
 *
 * SECURITY (V12 / T-mdt-03): `storagePath` is resolved against UPLOADS_DIR with the
 * SAME prefix guard as {@link readUpload}, so a traversal name like
 * `../../etc/passwd` (which would resolve outside the dir) THROWS before any unlink.
 * The path MUST originate from a userId-scoped recipient_sets row, never the client.
 */
export function deleteUpload(storagePath: string): void {
  const full = resolve(UPLOADS_DIR, storagePath);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)) {
    throw new Error("resolved upload path escaped the uploads directory");
  }
  try {
    unlinkSync(full);
  } catch (e) {
    // A missing file is fine (already gone) — swallow ENOENT, rethrow anything else.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
