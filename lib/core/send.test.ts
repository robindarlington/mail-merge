import { test } from "node:test";
import assert from "node:assert/strict";

// Drives lib/core/send.ts — the SMTP send engine lifted from the CLI
// (`send-credentials.ts` SMTP block + DELAY_MS throttle), with two fixes:
//   - an EXPLICIT `secure` boolean (NOT `port === 465` inference; PITFALLS #3), and
//   - a structured per-send result so the Phase 6 worker can catch-and-continue
//     instead of throw-and-abort on one bad recipient.
//
// No live SMTP: nodemailer transports are duck-typed (any object with
// sendMail), so a plain stub object exercises the full sendOne contract.
const { sendOne, verifyTransport, throttle } = await import("./send");

// A stub transport whose sendMail resolves — the success path.
function okTransport(messageId: string) {
  const calls: unknown[] = [];
  return {
    calls,
    async sendMail(opts: unknown) {
      calls.push(opts);
      return { messageId };
    },
  };
}

// A stub transport whose sendMail rejects — the failure path.
function failTransport(message: string) {
  return {
    async sendMail() {
      throw new Error(message);
    },
  };
}

test("sendOne returns { ok: true, messageId } on success and does not throw", async () => {
  const transport = okTransport("msg-abc");
  const res = await sendOne({
    transport,
    from: "sender@x.com",
    to: "rcpt@x.com",
    subject: "Hello",
    body: "World",
  });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.messageId, "msg-abc");
  // The message was built and handed to the transport.
  assert.equal(transport.calls.length, 1);
});

test("sendOne returns { ok: false, error } on failure and does NOT throw-and-abort", async () => {
  const transport = failTransport("550 mailbox unavailable");
  // Must resolve (not reject) so a Phase 6 batch survives one bad recipient.
  const res = await sendOne({
    transport,
    from: "sender@x.com",
    to: "bad@x.com",
    subject: "Hello",
    body: "World",
  });
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error);
  // The error info is serializable (carries the message, not a live Error throw).
  assert.match(JSON.stringify(res), /mailbox unavailable/);
});

test("sendOne passes subject + body through to the transport message", async () => {
  const transport = okTransport("msg-1");
  await sendOne({
    transport,
    from: "sender@x.com",
    to: "rcpt@x.com",
    subject: "Subj",
    body: "Body text",
  });
  const msg = transport.calls[0] as Record<string, unknown>;
  assert.equal(msg.subject, "Subj");
  assert.equal(msg.to, "rcpt@x.com");
  // Plain-text body (mail-merge bodies are plain text per PROJECT scope).
  assert.equal(msg.text, "Body text");
});

test("verifyTransport delegates to transport.verify()", async () => {
  let verified = false;
  const transport = {
    async verify() {
      verified = true;
      return true;
    },
  };
  await verifyTransport(transport);
  assert.equal(verified, true);
});

test("throttle waits roughly the configured delay and resolves", async () => {
  const start = Date.now();
  await throttle(30);
  assert.ok(Date.now() - start >= 25, "throttle should pause at least ~the delay");
});

test("throttle(0) resolves immediately (no delay configured)", async () => {
  const start = Date.now();
  await throttle(0);
  assert.ok(Date.now() - start < 20);
});
