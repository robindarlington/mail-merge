import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/smtp/errors.ts — the nodemailer verify() error classifier
// (SMTP-03 / D-06). Table-driven: each {code, message} fixture must map to a
// deterministic {kind, field}.
const { classifyVerifyError } = await import("./errors");

type Case = {
  name: string;
  err: { code?: string; message?: string };
  kind: "auth" | "connection" | "tls" | "unknown";
  field: "auth" | "hostPort" | "tlsMode" | "form";
};

const cases: Case[] = [
  {
    name: "EAUTH → auth/auth",
    err: { code: "EAUTH", message: "Invalid login: 535 authentication failed" },
    kind: "auth",
    field: "auth",
  },
  {
    name: "ESOCKET wrong version number → tls/tlsMode",
    err: {
      code: "ESOCKET",
      message: "140... error:1408F10B:SSL routines:wrong version number",
    },
    kind: "tls",
    field: "tlsMode",
  },
  {
    name: "ETIMEDOUT + greeting → tls/tlsMode",
    err: { code: "ETIMEDOUT", message: "Greeting never received" },
    kind: "tls",
    field: "tlsMode",
  },
  {
    name: "generic ssl handshake message → tls/tlsMode",
    err: { code: "ESOCKET", message: "SSL handshake failed" },
    kind: "tls",
    field: "tlsMode",
  },
  {
    name: "EDNS → connection/hostPort",
    err: { code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.bogus.example" },
    kind: "connection",
    field: "hostPort",
  },
  {
    name: "ECONNECTION → connection/hostPort",
    err: { code: "ECONNECTION", message: "connect ECONNREFUSED 1.2.3.4:587" },
    kind: "connection",
    field: "hostPort",
  },
  {
    name: "ETIMEDOUT (no greeting) → connection/hostPort",
    err: { code: "ETIMEDOUT", message: "Connection timeout" },
    kind: "connection",
    field: "hostPort",
  },
  {
    name: "ESOCKET (non-TLS message) → connection/hostPort",
    err: { code: "ESOCKET", message: "Socket closed unexpectedly" },
    kind: "connection",
    field: "hostPort",
  },
  {
    name: "unknown code → unknown/form",
    err: { code: "EWEIRD", message: "something surprising" },
    kind: "unknown",
    field: "form",
  },
  {
    name: "no code, no message → unknown/form",
    err: {},
    kind: "unknown",
    field: "form",
  },
];

for (const c of cases) {
  test(c.name, () => {
    const result = classifyVerifyError(c.err);
    assert.deepEqual(result, { kind: c.kind, field: c.field });
  });
}

test("TLS message takes precedence over the ESOCKET connection branch", () => {
  // An ESOCKET whose message is TLS-shaped must classify as tls, not connection.
  const result = classifyVerifyError({
    code: "ESOCKET",
    message: "wrong version number",
  });
  assert.equal(result.kind, "tls");
  assert.notEqual(result.kind, "connection");
});
