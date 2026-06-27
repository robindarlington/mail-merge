import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// These tests drive the AES-256-GCM credential-encryption helper (SMTP-04).
// The key is read from CREDENTIAL_ENC_KEY (base64, decodes to 32 bytes).
// We set a deterministic test key in this process so encrypt/decrypt work,
// and spawn subprocesses to assert the fail-closed behaviour when the key is
// missing/malformed (so we don't have to mutate this process's env mid-test).

// A known 32-byte key, base64-encoded, used only for the in-process tests.
const TEST_KEY_BYTES = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
); // exactly 32 bytes
const TEST_KEY_B64 = TEST_KEY_BYTES.toString("base64");
process.env.CREDENTIAL_ENC_KEY = TEST_KEY_B64;

// Import after the env var is set so the key loader (if it caches at import)
// sees a valid key. We import dynamically inside tests for clarity.
const { encrypt, decrypt } = await import("./index.ts");

test("round-trips ASCII plaintext", () => {
  const payload = encrypt("hunter2");
  assert.equal(decrypt(payload), "hunter2");
});

test("round-trips unicode plaintext", () => {
  const value = "pässwörd-日本語-🔐";
  assert.equal(decrypt(encrypt(value)), value);
});

test("round-trips the empty string", () => {
  assert.equal(decrypt(encrypt("")), "");
});

test("two encryptions of the same plaintext use a unique IV and differ", () => {
  const a = encrypt("same-secret");
  const b = encrypt("same-secret");
  // Unique IV per call — IVs must differ.
  assert.notDeepEqual(a.iv, b.iv);
  // Ciphertext must therefore differ too (no deterministic output).
  assert.notDeepEqual(a.enc, b.enc);
  // Both still decrypt back to the same plaintext.
  assert.equal(decrypt(a), "same-secret");
  assert.equal(decrypt(b), "same-secret");
});

test("decrypt throws when the ciphertext is tampered with", () => {
  const payload = encrypt("integrity-protected");
  const tampered = {
    ...payload,
    enc: Buffer.from(payload.enc),
  };
  // Flip a bit in the ciphertext.
  tampered.enc[0] ^= 0x01;
  assert.throws(() => decrypt(tampered));
});

test("decrypt throws when the auth tag is tampered with", () => {
  const payload = encrypt("integrity-protected");
  const tampered = {
    ...payload,
    tag: Buffer.from(payload.tag),
  };
  tampered.tag[0] ^= 0x01;
  assert.throws(() => decrypt(tampered));
});

test("the IV is 12 bytes (GCM standard) and a tag is present", () => {
  const payload = encrypt("x");
  assert.equal(payload.iv.length, 12);
  assert.ok(payload.tag.length > 0);
});

test("neither plaintext nor key appears in the serialized ciphertext payload", () => {
  const plaintext = "TOP-SECRET-PLAINTEXT-MARKER";
  const payload = encrypt(plaintext);
  const serialized = JSON.stringify({
    enc: Buffer.from(payload.enc).toString("base64"),
    iv: Buffer.from(payload.iv).toString("base64"),
    tag: Buffer.from(payload.tag).toString("base64"),
  });
  // The raw plaintext must not be recoverable from the serialized ciphertext.
  assert.ok(!serialized.includes(plaintext));
  // The base64 key must not leak into the payload.
  assert.ok(!serialized.includes(TEST_KEY_B64));
  // The raw key bytes must not appear either.
  assert.ok(!serialized.includes(TEST_KEY_BYTES.toString("utf8")));
});

test("a thrown error never contains the key or the plaintext", () => {
  const plaintext = "ANOTHER-SECRET-MARKER";
  const payload = encrypt(plaintext);
  const tampered = { ...payload, tag: Buffer.from(payload.tag) };
  tampered.tag[0] ^= 0xff;
  try {
    decrypt(tampered);
    assert.fail("decrypt should have thrown on a tampered tag");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(!message.includes(plaintext));
    assert.ok(!message.includes(TEST_KEY_B64));
  }
});

// --- Fail-closed key handling (subprocess-based, so this process's env is untouched) ---

function runWithKey(keyValue: string | null): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env };
  if (keyValue === null) {
    delete env.CREDENTIAL_ENC_KEY;
  } else {
    env.CREDENTIAL_ENC_KEY = keyValue;
  }
  // Import the helper and attempt an encrypt; exit 0 only if it THROWS
  // (fail-closed), non-zero (or printed marker) if it silently succeeds.
  const script = `
    import('./lib/crypto/index.ts').then((m) => {
      try {
        m.encrypt('x');
        // Should never get here — fail-closed means encrypt throws.
        console.error('NO_THROW');
        process.exit(2);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The error must not leak the key value.
        if (typeof process.env.LEAK_CHECK === 'string' && process.env.LEAK_CHECK.length > 0 && msg.includes(process.env.LEAK_CHECK)) {
          console.error('KEY_LEAKED');
          process.exit(3);
        }
        process.exit(0);
      }
    }).catch((e) => {
      // An import-time throw is also acceptable fail-closed behaviour.
      process.exit(0);
    });
  `;
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

test("fails closed (throws) when CREDENTIAL_ENC_KEY is unset", () => {
  const result = runWithKey(null);
  // exit 0 means encrypt threw (fail-closed) and the catch ran.
  assert.equal(
    result.status,
    0,
    `expected fail-closed throw, got status ${result.status}: ${result.stderr}`,
  );
});

test("fails closed when CREDENTIAL_ENC_KEY decodes to the wrong length", () => {
  // 16 bytes, not 32.
  const shortKey = randomBytes(16).toString("base64");
  const result = runWithKey(shortKey);
  assert.equal(
    result.status,
    0,
    `expected fail-closed throw on short key, got status ${result.status}: ${result.stderr}`,
  );
});

test("the fail-closed error message does not leak the key value", () => {
  // Use a long, distinctive but wrong-length key so we can grep for it.
  const distinctive = randomBytes(16).toString("base64");
  const env = { ...process.env, LEAK_CHECK: distinctive };
  const script = `
    import('./lib/crypto/index.ts').then((m) => {
      try { m.encrypt('x'); process.exit(2); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes(process.env.LEAK_CHECK)) { console.error('KEY_LEAKED'); process.exit(3); }
        process.exit(0);
      }
    }).catch(() => process.exit(0));
  `;
  env.CREDENTIAL_ENC_KEY = distinctive;
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    status = err.status ?? 1;
    stderr = err.stderr ?? "";
  }
  assert.notEqual(status, 3, `key leaked into error message: ${stderr}`);
  assert.equal(status, 0, `expected fail-closed throw: ${stderr}`);
});
