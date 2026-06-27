/**
 * AES-256-GCM credential encryption helper (SMTP-04).
 *
 * Phase 2's SMTP onboarding calls `encrypt()` to protect the user's SMTP
 * password before it is persisted; Phase 6's worker calls `decrypt()` at send
 * time. The output triple `{ enc, iv, tag }` maps directly onto the
 * `smtp_configs` blob columns authored in plan 01-02:
 *   enc → password_enc, iv → password_iv, tag → password_tag
 *
 * Security properties (see .planning/research/PITFALLS.md #1/#2, STACK.md
 * "Encrypting SMTP credentials at rest"):
 *  - AES-256-GCM authenticated encryption: a 12-byte IV is generated fresh per
 *    call (never reused) and the GCM auth tag is verified on decrypt, so a
 *    tampered ciphertext or tag is rejected (decrypt throws).
 *  - The 32-byte key is loaded at runtime from CREDENTIAL_ENC_KEY and fails
 *    closed if absent/malformed (see ./key.ts).
 *  - Nothing secret (key, plaintext, payload) is ever logged or serialized to a
 *    client boundary here — no console/pino calls on secrets.
 *
 * Key rotation is intentionally out of scope this phase; it can be added later
 * via a stored `key_id` selecting the right key (PITFALLS #1). Do NOT use the
 * deprecated `createCipher` (no IV) — only `createCipheriv` with a random IV.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { loadKey } from "./key";

const IV_BYTES = 12; // 96-bit IV is the GCM standard / recommended size

/**
 * The persisted ciphertext triple. Each field is a Buffer that maps onto a
 * `smtp_configs` blob column (password_enc / password_iv / password_tag).
 */
export interface EncryptedPayload {
  /** Ciphertext (maps to password_enc). */
  enc: Buffer;
  /** Random 12-byte IV, unique per call (maps to password_iv). */
  iv: Buffer;
  /** GCM authentication tag (maps to password_tag). */
  tag: Buffer;
}

/**
 * Encrypt a UTF-8 plaintext (e.g. an SMTP password) under the runtime key.
 * Generates a fresh random IV per call, so encrypting the same plaintext twice
 * yields different output. Returns the `{ enc, iv, tag }` triple to persist.
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  // Inline literal so the algorithm is unambiguous at the call site:
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
}

/**
 * Decrypt a previously-encrypted triple back to the original UTF-8 plaintext.
 * GCM verifies the auth tag in `final()`; a tampered ciphertext, IV, or tag
 * causes this to throw (authenticated-encryption integrity guarantee).
 */
export function decrypt(payload: EncryptedPayload): string {
  const key = loadKey();
  const iv = toBuffer(payload.iv);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(toBuffer(payload.tag));
  const plaintext = Buffer.concat([
    decipher.update(toBuffer(payload.enc)),
    decipher.final(), // throws on auth-tag mismatch
  ]);
  return plaintext.toString("utf8");
}

/**
 * Normalize a possibly-Uint8Array blob (as SQLite/Drizzle may hand back) into a
 * Buffer without copying when already a Buffer.
 */
function toBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
