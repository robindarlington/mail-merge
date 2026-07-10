/**
 * DTO redaction tests (SMTP-04 / T-2-CRED).
 *
 * The single server→client boundary is `toSmtpConfigDto`. These tests prove that
 * a known marker password — encrypted into a row exactly as production does —
 * can never appear in `JSON.stringify(toSmtpConfigDto(row))`, and that the DTO
 * carries no `password_*` keys at all. No database is needed: the DTO is a pure
 * projection over a row shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Deterministic 32-byte key so encrypt() works in-process for building a row.
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const { toSmtpConfigDto } = await import("./smtp");
const { encrypt } = await import("@/lib/crypto");

const MARKER_PASSWORD = "MARKER-PLAINTEXT-PASSWORD-DO-NOT-LEAK";

/** A full SmtpConfig row with the marker password encrypted into the triple. */
function makeRow() {
  const { enc, iv, tag } = encrypt(MARKER_PASSWORD);
  return {
    id: 1,
    userId: "user_marker_test_xxxxxxxxxx",
    host: "smtp.example.com",
    port: 465,
    secure: true,
    username: "marker-user",
    password_enc: enc,
    password_iv: iv,
    password_tag: tag,
    from_addr: "sender@example.com",
    from_name: "Sender",
    verified_at: 1_700_000_000,
    created_at: 1_699_000_000,
  };
}

test("the DTO has no password_* keys", () => {
  const dto = toSmtpConfigDto(makeRow());
  const keys = Object.keys(dto);
  assert.ok(
    !keys.some((k) => k.startsWith("password")),
    `DTO leaked a password key: ${keys.join(", ")}`,
  );
});

test("the marker plaintext password never appears in the serialized DTO", () => {
  const dto = toSmtpConfigDto(makeRow());
  const serialized = JSON.stringify(dto);
  assert.ok(
    !serialized.includes(MARKER_PASSWORD),
    "marker plaintext leaked into DTO JSON",
  );
});

test("the encrypted ciphertext bytes never appear in the serialized DTO", () => {
  const row = makeRow();
  const dto = toSmtpConfigDto(row);
  const serialized = JSON.stringify(dto);
  // Neither the base64 nor the hex form of any ciphertext part is present.
  for (const part of [row.password_enc, row.password_iv, row.password_tag]) {
    const buf = Buffer.from(part);
    assert.ok(!serialized.includes(buf.toString("base64")));
    assert.ok(!serialized.includes(buf.toString("hex")));
  }
});

test("the DTO exposes exactly the expected safe fields", () => {
  const dto = toSmtpConfigDto(makeRow());
  assert.deepEqual(Object.keys(dto).sort(), [
    "from_addr",
    "from_name",
    "host",
    "port",
    "secure",
    "username",
    "verified_at",
  ]);
});
