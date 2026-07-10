import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/smtp/schema.ts — the shared zod 4 SMTP onboarding schema
// (SMTP-01 field validation, SMTP-02 explicit TLS, T-2-SSRF host rejection).
const { smtpFormSchema, isPrivateHostLiteral } = await import("./schema");

const valid = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "user@example.com",
  password: "hunter2",
  from_addr: "sender@example.com",
  from_name: "Sender",
};

test("accepts a fully valid SMTP form", () => {
  const res = smtpFormSchema.safeParse(valid);
  assert.equal(res.success, true);
});

test("coerces a string port to a number (form control yields strings)", () => {
  const res = smtpFormSchema.safeParse({ ...valid, port: "465" });
  assert.equal(res.success, true);
  assert.equal(res.success && res.data.port, 465);
});

test("keeps the secure boolean verbatim — TLS is never inferred from the port", () => {
  // Port 465 with secure:false must stay secure:false (SMTP-02).
  const res = smtpFormSchema.safeParse({ ...valid, port: 465, secure: false });
  assert.equal(res.success, true);
  assert.equal(res.success && res.data.secure, false);
});

test("rejects a blank host", () => {
  const res = smtpFormSchema.safeParse({ ...valid, host: "   " });
  assert.equal(res.success, false);
});

test("rejects port 0", () => {
  const res = smtpFormSchema.safeParse({ ...valid, port: 0 });
  assert.equal(res.success, false);
});

test("rejects port 70000 (out of range)", () => {
  const res = smtpFormSchema.safeParse({ ...valid, port: 70000 });
  assert.equal(res.success, false);
});

test("rejects a non-email from_addr", () => {
  const res = smtpFormSchema.safeParse({ ...valid, from_addr: "not-an-email" });
  assert.equal(res.success, false);
});

test("rejects a blank username", () => {
  const res = smtpFormSchema.safeParse({ ...valid, username: "" });
  assert.equal(res.success, false);
});

test("rejects a blank password", () => {
  const res = smtpFormSchema.safeParse({ ...valid, password: "" });
  assert.equal(res.success, false);
});

test("from_name is optional", () => {
  const { from_name, ...withoutName } = valid;
  void from_name;
  const res = smtpFormSchema.safeParse(withoutName);
  assert.equal(res.success, true);
});

// --- T-2-SSRF: private-range / loopback host rejection (Pitfall 9) ---

test("rejects a 192.168.x private host (SSRF hygiene)", () => {
  const res = smtpFormSchema.safeParse({ ...valid, host: "192.168.1.25" });
  assert.equal(res.success, false);
});

test("rejects localhost, loopback, link-local and every RFC1918 range", () => {
  const blocked = [
    "localhost",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.0.1",
    "169.254.169.254", // cloud metadata endpoint
    "::1",
    "[::1]",
    "fe80::1",
    "0.0.0.0",
  ];
  for (const host of blocked) {
    assert.equal(
      isPrivateHostLiteral(host),
      true,
      `${host} should be treated as private`,
    );
    assert.equal(
      smtpFormSchema.safeParse({ ...valid, host }).success,
      false,
      `${host} should be rejected by the schema`,
    );
  }
});

test("does not reject a public host that merely looks numeric", () => {
  // 8.8.8.8 and 172.15.x / 172.32.x are outside the private ranges.
  for (const host of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "11.0.0.1"]) {
    assert.equal(
      isPrivateHostLiteral(host),
      false,
      `${host} should be allowed`,
    );
  }
});
