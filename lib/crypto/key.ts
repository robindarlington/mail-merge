/**
 * Fail-closed loader for the credential-encryption master key (SMTP-04).
 *
 * The 32-byte AES-256-GCM key is injected at runtime via the CREDENTIAL_ENC_KEY
 * environment variable (base64-encoded). It is NEVER committed to the repo and
 * NEVER written to the DB volume — only `.env.example` holds a placeholder, and
 * `.env` is gitignored (PITFALLS #1: keep the key out of the DB and out of the
 * bundled code, separate from the ciphertext).
 *
 * Fail-closed (Claude's-discretion decision, 01-CONTEXT.md): if the variable is
 * absent or does not decode to exactly 32 bytes, this throws a clear, secret-free
 * error rather than silently encrypting under a weak/empty key. Error messages
 * intentionally contain neither the key value nor any plaintext (PITFALLS #2).
 *
 * Key rotation is out of scope for this phase but can be added later by storing a
 * `key_id` alongside each ciphertext and selecting the matching key here
 * (PITFALLS #1, versioned keys). Do NOT implement rotation now.
 */

const KEY_ENV_VAR = "CREDENTIAL_ENC_KEY";
const REQUIRED_KEY_BYTES = 32; // AES-256 → 32-byte key

/**
 * Read, decode, and validate the master key from the environment. Throws a
 * secret-free error when the key is missing or not exactly 32 bytes.
 *
 * The key is read fresh on each call (no module-level caching) so that the
 * fail-closed behaviour holds regardless of import order and so tests can run
 * sub-scenarios in isolated processes.
 */
export function loadKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];

  if (raw === undefined || raw.length === 0) {
    throw new Error(`${KEY_ENV_VAR} is missing — refusing to encrypt/decrypt`);
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    // Buffer.from never throws for base64, but guard defensively without
    // echoing the (secret) input value.
    throw new Error(`${KEY_ENV_VAR} could not be base64-decoded`);
  }

  if (decoded.length !== REQUIRED_KEY_BYTES) {
    // Report only the observed length, never the key material itself.
    throw new Error(
      `${KEY_ENV_VAR} must decode to ${REQUIRED_KEY_BYTES} bytes (got ${decoded.length})`,
    );
  }

  return decoded;
}
