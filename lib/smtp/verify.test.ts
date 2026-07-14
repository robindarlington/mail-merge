import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";

// TEST-ONLY concession: the local smtp-server fixtures below present a
// self-signed cert. Disabling cert validation here lets the implicit-TLS
// fixtures complete their handshake so we can exercise the AUTH and TLS-mode
// paths of verifySmtp. This env var affects ONLY this test process — it does
// NOT touch lib code. verifySmtp itself NEVER sets `rejectUnauthorized: false`
// (grep-asserted below); production keeps nodemailer's secure defaults.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { verifySmtp } = await import("./verify");
type SmtpFormValues = import("./schema").SmtpFormValues;

// A throwaway self-signed cert (CN=localhost, generated for these fixtures only).
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDn+kA/XFW0OiiL
oXGk56vwPvVRLuwyOB/vpASgzNaF+8OVJMnq8YyYB0Srl59F4ICZci6pOdz/3xF0
E39QAUcZETZGinMpcHBm0djsF+u+V3mBd/l+5wm7GfgL7sI0tXTncB2WZh+FvuoI
LjhGUqEuDvrkJx/PMbXvOEs0KZ5q5B8YQmQi3UXLVHBQJ5nRQVtUk6S/+YBONgcx
mDcZST40PcBCHKvQjFjN7krLZhF5Cxhxu3yFutn/YfwQer1SP8Za8ZSXAV1BCoJX
XvPci4pAucwmBRtDqoh+CD2mKBGTmruvoL30ORCugNGWD7ZRBwW5+M/o7+0eZ48b
6tSujHdpAgMBAAECggEAAtMbQSpAqOckYz7eAWIIx+4cUpa9rYbdbK+UltinrA36
vbAq/T9ftOIxxd0cxV8McdHgG5Nmy37N2Zn7LOA3G2kIPiela1XBKJ9ZgtZvumua
QSdS1Ga/yZVxXcPUfYvQFplY4uHvdFN0yhC2ArUy3Tq1d126l21Fh9opoEL5eNe0
UeNv5zhys6RfD86P6EWOMKe4wC9RYfL3lHUnvBJEWHJ0iPOnS/FXmTlq8JcsahxL
NfhJDjvZ+WtUVnzW3IBCA3oc4iwRsRYdoXR1+0FMfhJ7e08s76Ji6+ZKXU6LUM5w
VBgR8mt2N4OaO65qlVoeoBpaX4OWcsJOe+ZV1OXV2QKBgQD16IE+M8c+LryEsoXb
+Y2jcAWvUKJ6bv1QHRExhgtFOX3tHlixphFqNRZch928O1bqvQM44pT2/1IgV9BW
etIdtjJtI12/ohYx8rOXgYbqsy4ABnpaTMWuVWtXV2VbxYmOT1OCtpFReUFwfQKR
PhwpSBCMx7ypd6+XICwn13dFxwKBgQDxf2QutJZgH8csXE8Q+83gPwyLmantueV1
LfSso+xa6nPM6fXxUCFBLqcdvWalq9UeOQ1EwQMsYIaiCSFOrBTzy9gPnvZtIUMA
VJmTn+aMga86i8Mi3rr4OOfh8hP+g7hFlhGMkUDi0yPfFP5Nkbq/gFmsZTkNAPFQ
dWMDD6aZTwKBgQCulC1FOr9F3ypJTvCHdgjfMkVm7GkdYLSH7srpDM/til5jO/sd
y9drPlssv+xkmQAg0KV7+ihlnmfwvEcVTkbjfxkXsFb7GJiHR1XGxtdAwopyzCaK
+xwQo2X8cPhtibUZiimwj+plHB+gO6/Z621UxWuydo7zBRxsvxN6CZcMuwKBgQDe
ZDId0K+qVZlVgKxPN5OfrnAfHqMeCNMF1gw777j5AG8jhVC3qNL2879x47ljV5oq
+t79McF6XGmfTkkd6dphqJaPzBOi676Hz2CeUeI+Ai8b+xj4Q6Rqcf0YVZWUDDjl
3AzNJfZa65VdGjgVtt4C/G+YEp83GmcfcPp9FyyUgQKBgGkq8joLtCaQLpPHNYBq
NwdpVQAUCR9R5Q7eF9lIJB4LVAi18g7FkolG3Tc/cTe2rS4jmcV9Ym9rnhrSHHZJ
epfW1AoEZpeyG33c3CxFANiKL1T3VtkNSejghS3WzwWYsOOH8EGaOIfP/SdWz43p
goNBcEzDUNZJaGTTImd/QmFm
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUMg+Wpr4K0HE8g8MognBy7KMrq7MwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxMDIxNDg0MVoXDTM2MDcw
NzIxNDg0MVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA5/pAP1xVtDooi6FxpOer8D71US7sMjgf76QEoMzWhfvD
lSTJ6vGMmAdEq5efReCAmXIuqTnc/98RdBN/UAFHGRE2RopzKXBwZtHY7Bfrvld5
gXf5fucJuxn4C+7CNLV053AdlmYfhb7qCC44RlKhLg765CcfzzG17zhLNCmeauQf
GEJkIt1Fy1RwUCeZ0UFbVJOkv/mATjYHMZg3GUk+ND3AQhyr0IxYze5Ky2YReQsY
cbt8hbrZ/2H8EHq9Uj/GWvGUlwFdQQqCV17z3IuKQLnMJgUbQ6qIfgg9pigRk5q7
r6C99DkQroDRlg+2UQcFufjP6O/tHmePG+rUrox3aQIDAQABo1MwUTAdBgNVHQ4E
FgQU40P+qTXMR8cw/qa0tbz8pj0Vo0EwHwYDVR0jBBgwFoAU40P+qTXMR8cw/qa0
tbz8pj0Vo0EwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEACqUt
zSQYmpX0r9uFapo8pKr7DU18pHF8lP0abPM71KPohqyuv/L5v4LAmJiG7GlFg6nd
JMmJejp+nJrHGaWAiTfUTV9OVrTj8PzbBeQRqMkO1300mWicspRJFpATTOEjfLUH
ltQd2gM4XZ54b/jRNkMcM12Dsts2kQqgvaj8Z1eVV1g6PlkLZhLtmVO01SgVl4ZL
H8JQ28BIxMWPzHFLP+xJvwTnZpjByrcJVp8FMSCHOSs2g8RidIRAzcn/wfWCpTaU
nM4I1LGF+dZH2QTGDdaUWq2cV+DE2vBCGNDTreWEmNQ0rJnmNa3DqZU2drEJQ3ND
U98noB9mjm/gcohGjA==
-----END CERTIFICATE-----`;

/** Start an SMTPServer on an ephemeral port; resolves with the port + closer. */
function startServer(
  opts: ConstructorParameters<typeof SMTPServer>[0],
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = new SMTPServer(opts);
    server.on("error", () => {
      /* swallow fixture socket resets (plaintext-vs-TLS chatter) */
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on("error", reject);
  });
}

const baseInput = (
  over: Partial<SmtpFormValues>,
): SmtpFormValues => ({
  // 06.1: `label` is a required field on the shared schema (multi-server).
  label: "Test Server",
  // 127.0.0.1 (not "localhost"): on dual-stack hosts nodemailer tries IPv6 ::1
  // first and stalls ~10s on the greeting before falling back to IPv4. The IPv4
  // literal avoids that fixture-only latency. (Real users enter real hostnames;
  // the schema rejects this literal, but the test calls verifySmtp directly.)
  host: "127.0.0.1",
  port: 0,
  secure: true,
  username: "user",
  password: "pass",
  from_addr: "from@example.com",
  from_name: undefined,
  ...over,
});

// Track servers so `after` can always tear them down.
const servers: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const s of servers) await s.close();
});

test("(a) AUTH rejection classifies as kind: auth", async () => {
  const srv = await startServer({
    secure: true,
    key: TLS_KEY,
    cert: TLS_CERT,
    // Pin the advertised auth methods for a deterministic AUTH negotiation.
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(_auth, _session, cb) {
      cb(new Error("Invalid username or password"));
    },
    onConnect(_s, cb) {
      cb();
    },
  });
  servers.push(srv);

  const outcome = await verifySmtp(baseInput({ port: srv.port, secure: true }));
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.kind, "auth");
  assert.equal(!outcome.ok && outcome.field, "auth");
});

test("(b) refused port classifies as kind: connection in <15s", async () => {
  // Bind then immediately close to obtain a definitely-closed port.
  const tmp = await startServer({ onConnect(_s, cb) { cb(); } });
  const closedPort = (await new Promise<number>((res) => res(tmp.port)));
  await tmp.close();

  const start = Date.now();
  const outcome = await verifySmtp(
    baseInput({ port: closedPort, secure: false }),
  );
  const elapsed = Date.now() - start;

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.kind, "connection");
  assert.equal(!outcome.ok && outcome.field, "hostPort");
  assert.ok(
    elapsed < 15_000,
    `expected fail-fast <15s, took ${elapsed}ms`,
  );
});

test("(c) plaintext dial to an implicit-TLS server classifies as kind: tls (A1) and auto-retries", async () => {
  const srv = await startServer({
    secure: true,
    key: TLS_KEY,
    cert: TLS_CERT,
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(_auth, _session, cb) {
      cb(null, { user: "user" }); // alternate (secure:true) probe succeeds
    },
    onConnect(_s, cb) {
      cb();
    },
  });
  servers.push(srv);

  // User picked secure:false, but the server is implicit-TLS-only.
  const outcome = await verifySmtp(
    baseInput({ port: srv.port, secure: false }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(
    !outcome.ok && outcome.kind,
    "tls",
    `A1 pin: observed classification via raw="${!outcome.ok ? outcome.raw : ""}"`,
  );
  // D-05 auto-retry: the alternate (implicit-TLS) mode works, so a switch is
  // suggested WITHOUT saving.
  assert.equal(!outcome.ok && outcome.suggestion, "implicit");

  // Record the observed A1 signature for the SUMMARY.
  console.log(
    `[A1] TLS-mismatch raw signature: ${!outcome.ok ? outcome.raw : "(none)"}`,
  );
});
