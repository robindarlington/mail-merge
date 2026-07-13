/**
 * lib/campaign/actions-core — the testable orchestration seam behind the campaign
 * Server Action in ./actions.ts. This module deliberately carries NO "use server"
 * directive: in Next.js every runtime export of a server-action module is
 * registered as a client-invocable endpoint, and this seam accepts a caller
 * supplied `userId` (and, for tests, an injected transport) so exporting it from
 * the action module would let a client bypass `auth()` entirely (T-5-IDOR /
 * T-5-ENDPOINT / AUTH-02). Here it is a plain server-side function: importable by
 * ./actions.ts and by tests, but never wire-callable.
 *
 * sendTestBatchChunkCore — the whole-batch test-send, expressed as a bounded,
 * client-drivable CHUNK (TEST-01). Each call sends one slice of the recipient
 * rows — every message personalized in BOTH subject and body and redirected to a
 * single test address (CLI --test parity) — and returns a cursor
 * ({nextOffset, done, total}) so the client loops the chunks over the FULL row
 * set. This is the deliberate resolution of the RESEARCH Pitfall-1 tension
 * ("whole batch, 500ms throttle, no hard cap" vs. a ~60s reverse-proxy read
 * timeout): the batch is split into short requests the client drives — no worker
 * (Phase 6), no row cap, real progress.
 *
 * It reuses the verified pure primitives verbatim — `fillMessage`, `sendOne`,
 * `createSmtpTransport`, `verifyTransport`, `throttle`, `decrypt`, `parseCsv` —
 * so there is NO new merge / send / transport / crypto code here.
 *
 * SECURITY:
 *  - T-5-IDOR: the recipient set / template / SMTP config are resolved through the
 *    userId-scoped DAL (`getRecipientSetForUser` / `getTemplateForUser` /
 *    `getSmtpConfigForUser`); a client id owned by another tenant → not_found. The
 *    storage path comes from the userId-scoped row, NEVER from the client.
 *  - T-5-CRED / SMTP-04 / D-06: the SMTP password is decrypted transiently into a
 *    local and never reaches a result field, a throw, or a log; `errors[]` carries
 *    only `res.error.message` strings, never a raw Error object.
 */

import type { MailTransport } from "@/lib/core";
import {
  createSmtpTransport,
  fillMessage,
  parseCsv,
  sendOne,
  throttle,
  verifyTransport,
} from "@/lib/core";
import { decrypt } from "@/lib/crypto";
import {
  getRecipientSetForUser,
  getSmtpConfigForUser,
  getTemplateForUser,
} from "@/lib/data";
import { readUpload } from "@/lib/csv";
import {
  recipientSetIdSchema,
  templateIdSchema,
  testAddressSchema,
  chunkOffsetSchema,
  TEST_SEND_CHUNK_SIZE,
} from "./schema";

/**
 * The typed failure surface the seam returns. A closed union of message-only
 * shapes — a `raw` field is ALWAYS a string, never a raw Error, the config, or CSV
 * bytes (T-5-CRED / T-5-LOG / D-06). This is the contract the campaign UI matches.
 */
export type ActionError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }
  | { kind: "no_smtp_config" }
  | { kind: "parse_error" }
  | { kind: "already_queued" }
  | { kind: "send_failed"; raw: string }
  | { kind: "unknown"; raw: string };

/**
 * The per-chunk result payload. `sent`/`failed` count this chunk's rows;
 * `errors` are per-row failure MESSAGE strings (never raw Errors). `nextOffset` +
 * `done` are the cursor the client loops on; `total` is the full row count so the
 * client can render whole-batch progress.
 */
export type TestSendData = {
  sent: number;
  failed: number;
  errors: string[];
  nextOffset: number;
  done: boolean;
  total: number;
};

/** The uniform result the seam resolves to (never rejects). */
export type TestSendResult =
  | { ok: true; data: TestSendData }
  | { ok: false; error: ActionError };

/** The untrusted input the client supplies (ids + address + cursor offset). */
export type TestSendInput = {
  recipientSetId: unknown;
  templateId: unknown;
  testAddress: unknown;
  offset: unknown;
};

// papaparse emits `UndetectableDelimiter` for a legitimate single-column CSV (and
// an empty file) — the parse itself SUCCEEDS. Only genuine structural errors
// (MissingQuotes, TooFewFields, …) are a misparse. Mirrors compose/actions-core.ts.
function hasStructuralParseError(
  errors: ReturnType<typeof parseCsv>["parseErrors"],
): boolean {
  return errors.some((e) => e.code !== "UndetectableDelimiter");
}

/**
 * Test-send seam (testable): validate → userId-scoped resolve → read CSV →
 * decrypt → verify-once (chunk 0) → fill+send the slice → return a cursor. The
 * `transportOverride` lets tests inject a fake `MailTransport` so no live socket
 * is opened; production passes none and builds the real transport from the saved
 * config. `delayMs` is the inter-send throttle applied BETWEEN sends only (never
 * after the last row of a chunk); it defaults to 0 for the pure seam and is
 * injected as `TEST_SEND_DELAY_MS` by the production wrapper (the composition
 * root), so a test never sleeps and production always paces at 500ms.
 */
export async function sendTestBatchChunkCore(
  userId: string,
  input: TestSendInput,
  transportOverride?: MailTransport,
  delayMs: number = 0,
): Promise<TestSendResult> {
  // Validate every untrusted field up front — a NaN/0/negative id or a bad
  // address fails as `validation` rather than resolving a bogus row (T-5-IDOR).
  const idParsed = recipientSetIdSchema.safeParse(input.recipientSetId);
  const tplParsed = templateIdSchema.safeParse(input.templateId);
  const addrParsed = testAddressSchema.safeParse(input.testAddress);
  const offsetParsed = chunkOffsetSchema.safeParse(input.offset);
  if (
    !idParsed.success ||
    !tplParsed.success ||
    !addrParsed.success ||
    !offsetParsed.success
  ) {
    const issues = [
      ...(idParsed.success ? [] : idParsed.error.issues),
      ...(tplParsed.success ? [] : tplParsed.error.issues),
      ...(addrParsed.success ? [] : addrParsed.error.issues),
      ...(offsetParsed.success ? [] : offsetParsed.error.issues),
    ];
    return { ok: false, error: { kind: "validation", issues } };
  }
  const recipientSetId = idParsed.data;
  const templateId = tplParsed.data;
  const testAddress = addrParsed.data;
  const offset = offsetParsed.data;

  // Resolve everything through the userId-scoped DAL — a cross-tenant id (or a
  // bogus one) returns undefined. NEVER trust a client-supplied storage path.
  const set = await getRecipientSetForUser(userId, recipientSetId);
  if (!set) return { ok: false, error: { kind: "not_found" } };
  const template = await getTemplateForUser(userId, templateId);
  if (!template) return { ok: false, error: { kind: "not_found" } };
  const cfg = await getSmtpConfigForUser(userId);
  if (!cfg) return { ok: false, error: { kind: "no_smtp_config" } };

  // Read + parse the CSV server-side (storage_path came from the userId-scoped
  // row; readUpload also enforces the traversal boundary).
  let rows: Record<string, string>[];
  let total: number;
  try {
    const bytes = readUpload(set.storage_path);
    const parsed = parseCsv(bytes);
    if (hasStructuralParseError(parsed.parseErrors)) {
      return { ok: false, error: { kind: "parse_error" } };
    }
    rows = parsed.rows;
    total = rows.length;
  } catch (e) {
    // raw is ALWAYS a string — never a raw Error or bytes (T-5-LOG / D-06).
    return { ok: false, error: { kind: "unknown", raw: String((e as Error)?.message ?? e) } };
  }

  const slice = rows.slice(offset, offset + TEST_SEND_CHUNK_SIZE);

  // Decrypt the AES-256-GCM triple server-side ONLY — the plaintext lives
  // transiently in this local and never reaches a result field, a throw, or a log
  // (T-5-CRED / SMTP-04). It is used solely to build the real transport below;
  // when a test injects `transportOverride`, createSmtpTransport is never called.
  const password = decrypt({
    enc: cfg.password_enc as Buffer,
    iv: cfg.password_iv as Buffer,
    tag: cfg.password_tag as Buffer,
  });
  const transport: MailTransport =
    transportOverride ??
    (createSmtpTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: password },
    }) as unknown as MailTransport);

  const from = cfg.from_name
    ? `${cfg.from_name} <${cfg.from_addr}>`
    : cfg.from_addr;

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    // Carry-forward CLAUDE.md constraint: verify() BEFORE any send — but only on
    // the first chunk (offset 0). Connectivity proven on chunk 0 need not be
    // re-proven on every later chunk. A verify failure returns WITHOUT sending.
    if (offset === 0) {
      try {
        await verifyTransport(transport);
      } catch (err) {
        return {
          ok: false,
          error: { kind: "send_failed", raw: (err as Error)?.message ?? String(err) },
        };
      }
    }

    for (let i = 0; i < slice.length; i++) {
      const { subject, body } = fillMessage(
        { subject: template.subject, body: template.body },
        slice[i],
      );
      const res = await sendOne({ transport, from, to: testAddress, subject, body });
      if (res.ok) {
        sent++;
      } else {
        // message string ONLY — never the raw Error object (D-06).
        failed++;
        errors.push(res.error.message);
      }
      // Throttle BETWEEN sends only — never after the last row of the chunk.
      if (i < slice.length - 1) await throttle(delayMs);
    }
  } finally {
    // Never leak the socket. A stub transport has no close() — guard it.
    const closable = transport as { close?: () => void };
    if (typeof closable.close === "function") closable.close();
  }

  const nextOffset = offset + slice.length;
  return {
    ok: true,
    data: { sent, failed, errors, nextOffset, done: nextOffset >= total, total },
  };
}
