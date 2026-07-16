/**
 * lib/attachments/storage — traversal-proof attachment persistence
 * (ATCH-03 / T-07-01 / T-07-02).
 *
 * The ONLY module that writes uploaded attachment bytes to disk. It mirrors
 * `lib/csv/storage.ts` (env-path resolver → mkdirSync → write) and shares the
 * SAME `UPLOADS_PATH` volume (CONTEXT decision), so uploads are configured in
 * exactly one place.
 *
 * SECURITY (ATCH-03 / T-07-01): the on-disk file is named from
 * `crypto.randomUUID()` with a FIXED `.bin` extension — the user-supplied
 * filename and its original extension are NEVER trusted into the path, so a name
 * like `../../etc/passwd` can never become a path component. The original
 * filename is kept in the DB (attachments.filename) for matching + display only.
 *
 * The returned `storagePath` is the RELATIVE `<uuid>.bin`; callers resolve it
 * against UPLOADS_DIR at read time (Pitfall 4 — absolute paths don't survive the
 * dev→container boundary).
 *
 * Unlike the CSV reader, the worker forwards the resolved ABSOLUTE path straight
 * to nodemailer's `attachments: [{ path }]` and never reads bytes into memory —
 * so this module exposes `resolveAttachmentPath` (returns the path) +
 * `attachmentExists` (presence check) rather than a byte reader.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Resolve the uploads directory. Prod: Coolify sets UPLOADS_PATH → /data/uploads;
 * native dev falls back to ./data/uploads. SAME volume as CSV uploads.
 */
const UPLOADS_DIR = resolve(process.env.UPLOADS_PATH ?? "./data/uploads");

/**
 * Resolve a stored RELATIVE `storagePath` to an absolute on-disk path, rejecting
 * any path that escapes UPLOADS_DIR (T-07-02). Shared by the resolver + the
 * presence check so both enforce the identical traversal boundary.
 */
function guardedResolve(storagePath: string): string {
  const full = resolve(UPLOADS_DIR, storagePath);
  if (full !== UPLOADS_DIR && !full.startsWith(UPLOADS_DIR + sep)) {
    throw new Error("resolved attachment path escaped the uploads directory");
  }
  return full;
}

/**
 * Persist `bytes` under an opaque `<uuid>.bin` name and return the RELATIVE
 * storage path. The user filename/extension is never part of the path
 * (traversal-proof, ATCH-03 / T-07-01).
 */
export function writeAttachment(bytes: Buffer): { storagePath: string } {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${randomUUID()}.bin`; // opaque — user filename never in the path
  writeFileSync(resolve(UPLOADS_DIR, name), bytes);
  return { storagePath: name }; // store RELATIVE; resolve at read time (Pitfall 4)
}

/**
 * Resolve a previously-stored attachment to its ABSOLUTE on-disk path, for the
 * worker to hand to nodemailer's `attachments: [{ path }]`.
 *
 * SECURITY (T-07-02): `storagePath` is resolved against UPLOADS_DIR and
 * prefix-checked, so a traversal name like `../../etc/passwd` is rejected before
 * any disk access. IDOR: `storagePath` MUST originate from a userId-scoped
 * attachments row — this function enforces only the traversal boundary, not
 * ownership.
 */
export function resolveAttachmentPath(storagePath: string): string {
  return guardedResolve(storagePath);
}

/**
 * Report whether a stored attachment is present on disk (the pre-send presence
 * validation, ATCH-02). Runs the same traversal guard as
 * {@link resolveAttachmentPath}, so a traversal path throws rather than leaking a
 * filesystem probe.
 */
export function attachmentExists(storagePath: string): boolean {
  return existsSync(guardedResolve(storagePath));
}
