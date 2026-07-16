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
 *    `getSmtpConfigByIdForUser`); a client id owned by another tenant → not_found.
 *    The storage path comes from the userId-scoped row, NEVER from the client. The
 *    SMTP config is resolved by the client-proposed `smtpConfigId`, owner-scoped
 *    (T-061-09): an unknown / deleted / cross-tenant id resolves to undefined →
 *    not_found, so nothing is sent (06.1 multi-server).
 *  - T-5-CRED / SMTP-04 / D-06: the SMTP password is decrypted transiently into a
 *    local and never reaches a result field, a throw, or a log; `errors[]` carries
 *    only `res.error.message` strings, never a raw Error object.
 */

import type { MailTransport } from "@/lib/core";
import {
  analyzeMerge,
  countInvalidEmails,
  createSmtpTransport,
  detectEmailColumn,
  extractTokens,
  fillMessage,
  parseCsv,
  resolveAttachmentColumn,
  sendOne,
  throttle,
  verifyTransport,
} from "@/lib/core";
import { computeAttachmentMatch, deleteAttachment } from "@/lib/attachments";
import { decrypt } from "@/lib/crypto";
import {
  createDraftCampaign,
  deleteCampaignForUser,
  enqueueCampaign as enqueueCampaignDal,
  getCampaignForUser,
  getCampaignProgressRow,
  getRecipientSetForUser,
  getSmtpConfigByIdForUser,
  getTemplateForUser,
  listAttachmentsForCampaign,
  stampCampaignOnPendingAttachments,
  toSmtpConfigDto,
} from "@/lib/data";
import { readUpload } from "@/lib/csv";
import {
  campaignIdSchema,
  recipientSetIdSchema,
  smtpConfigIdSchema,
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
  | { kind: "attachments_blocked" }
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

/** The untrusted input the client supplies (ids + address + cursor offset). The
 *  `smtpConfigId` is the client-proposed choice of which verified server to send
 *  through — always owner-re-resolved server-side (06.1 multi-server). */
export type TestSendInput = {
  recipientSetId: unknown;
  templateId: unknown;
  smtpConfigId: unknown;
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
  const cfgIdParsed = smtpConfigIdSchema.safeParse(input.smtpConfigId);
  const addrParsed = testAddressSchema.safeParse(input.testAddress);
  const offsetParsed = chunkOffsetSchema.safeParse(input.offset);
  if (
    !idParsed.success ||
    !tplParsed.success ||
    !cfgIdParsed.success ||
    !addrParsed.success ||
    !offsetParsed.success
  ) {
    const issues = [
      ...(idParsed.success ? [] : idParsed.error.issues),
      ...(tplParsed.success ? [] : tplParsed.error.issues),
      ...(cfgIdParsed.success ? [] : cfgIdParsed.error.issues),
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
  // Owner-re-resolve the client-proposed server choice by id (T-061-09): an
  // unknown / deleted / cross-tenant smtpConfigId → undefined → not_found; nothing
  // is sent. The encrypted config is loaded from THIS owner-scoped row only.
  const cfg = await getSmtpConfigByIdForUser(userId, cfgIdParsed.data);
  if (!cfg) return { ok: false, error: { kind: "not_found" } };

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

// --- Confirmation gate (TEST-02) + single draft→queued transition (TEST-03) ---
//
// Three seams wire the gate over the campaigns DAL (Plan 01):
//   prepareCampaignCore     — creates the draft at the "review and send" moment
//                             (decision A1/U7) from the caller's recipient set +
//                             template + saved SMTP config (all three FKs).
//   buildConfirmSummaryCore — the SERVER-AUTHORITATIVE review payload the modal
//                             renders; every number is recomputed server-side from
//                             the stored CSV + template, so a tampered client
//                             payload can neither suppress a warning nor enqueue
//                             past the guard. The client passes ONLY a campaignId.
//   enqueueCampaignCore     — the atomic draft→queued transition; a 0-row result
//                             (double-submit OR cross-tenant/not-draft) maps to the
//                             benign already_queued, never a duplicate transition.

/**
 * The server-authoritative review payload the confirm modal renders (TEST-02).
 * Every field is RECOMPUTED server-side from the campaign's own FKs (its stored
 * CSV + template + redacted SMTP DTO) — the client supplies only a campaignId, so
 * it cannot influence a single number here (T-5-TAMPER). `senderIdentity` comes
 * from `toSmtpConfigDto`, which structurally cannot carry the password (T-5-CRED).
 */
export type ConfirmSummary = {
  campaignId: number;
  recipientCount: number;
  senderIdentity: string;
  sample: { to: string; subject: string; body: string; attachment?: string };
  invalidEmailCount: number;
  rowsWithGaps: number;
  unknownTokens: string[];
  sendableCount: number;
  // --- Attachment aggregates (Plan 03), recomputed server-side via the SHARED
  // computeAttachmentMatch so they can never diverge from the compose card. ---
  /** The resolved attachment column, or null when none is chosen/detected. */
  attachmentColumn: string | null;
  /** Rows whose non-empty cell matched an uploaded (DB-present) file. */
  rowsWithAttachment: number;
  /** Matched rows whose file is actually present on disk (ready to send). */
  attachmentTotal: number;
  /** Deduped sample of missing referenced filenames (capped at 5) for the UI. */
  missingAttachmentFilenames: string[];
  /** Total rows referencing a file that is missing (never-uploaded or off-disk). */
  missingAttachmentCount: number;
  /** Rows whose attachment exceeds the per-message cap (MAX_MESSAGE_BYTES). */
  oversizeRowCount: number;
};

/** The untrusted input for prepare (ids the client selected). `smtpConfigId` is
 *  the client-proposed choice of which verified server the campaign sends through;
 *  it is owner-re-resolved and stamped on the draft (06.1 multi-server). */
export type PrepareInput = {
  recipientSetId: unknown;
  templateId: unknown;
  smtpConfigId: unknown;
};
/** The untrusted input for summary/enqueue — ONLY a campaignId after prepare. */
export type ConfirmInput = { campaignId: unknown };

/** Uniform results (never reject). */
export type PrepareResult =
  | { ok: true; data: { campaignId: number } }
  | { ok: false; error: ActionError };
export type SummaryResult =
  | { ok: true; data: ConfirmSummary }
  | { ok: false; error: ActionError };
export type EnqueueResult =
  | { ok: true; data: { campaignId: number } }
  | { ok: false; error: ActionError };

/**
 * Prepare seam (testable): validate the selected ids → userId-scoped resolve of the
 * recipient set + template (cross-tenant/bogus id → not_found) and the
 * client-chosen SMTP config by id (unknown/deleted/cross-tenant → not_found) →
 * create the draft campaign wiring all three FKs, STAMPING the resolved config id.
 *
 * This is the A1/U7 timing: the draft is created HERE (the "review and send"
 * moment), NOT at template save — the three FKs are NOT NULL, so a draft can only
 * exist once recipient set + template + SMTP config all do. Ownership is
 * server-injected by the DAL (`createDraftCampaign` spreads userId LAST), so a
 * caller can never spoof it (T-5-IDOR / T-5-TAMPER-OWNER). The server choice is
 * owner-re-resolved (T-061-09): a missing/invalid smtpConfigId fails as
 * `validation`; an unknown/deleted/cross-tenant one → not_found — nothing created.
 */
export async function prepareCampaignCore(
  userId: string,
  input: PrepareInput,
): Promise<PrepareResult> {
  const idParsed = recipientSetIdSchema.safeParse(input.recipientSetId);
  const tplParsed = templateIdSchema.safeParse(input.templateId);
  const cfgIdParsed = smtpConfigIdSchema.safeParse(input.smtpConfigId);
  if (!idParsed.success || !tplParsed.success || !cfgIdParsed.success) {
    const issues = [
      ...(idParsed.success ? [] : idParsed.error.issues),
      ...(tplParsed.success ? [] : tplParsed.error.issues),
      ...(cfgIdParsed.success ? [] : cfgIdParsed.error.issues),
    ];
    return { ok: false, error: { kind: "validation", issues } };
  }

  // Resolve every FK through the userId-scoped DAL — a cross-tenant (or bogus) id
  // returns undefined → not_found, and NOTHING is created.
  const set = await getRecipientSetForUser(userId, idParsed.data);
  if (!set) return { ok: false, error: { kind: "not_found" } };
  const template = await getTemplateForUser(userId, tplParsed.data);
  if (!template) return { ok: false, error: { kind: "not_found" } };
  // Owner-re-resolve the client-proposed server choice by id (T-061-09). Unknown /
  // deleted / cross-tenant → undefined → not_found; nothing is created.
  const cfg = await getSmtpConfigByIdForUser(userId, cfgIdParsed.data);
  if (!cfg) return { ok: false, error: { kind: "not_found" } };

  try {
    const [created] = await createDraftCampaign(userId, {
      recipient_set_id: set.id,
      template_id: template.id,
      smtp_config_id: cfg.id,
    });
    // Stamp the user's uploads onto the freshly-created draft (BLOCKER-1). The DAL
    // is IDEMPOTENT (claims unstamped OR still-draft-owned rows, userId-scoped), so
    // re-opening the send dialog — which mints a NEW draft on every open — re-claims
    // the prior draft's attachments onto this one instead of stranding them
    // (PATTERNS "Prepare-time stamping" / T-07-10 / T-07-17). Safe on every prepare.
    await stampCampaignOnPendingAttachments(userId, created.id);
    return { ok: true, data: { campaignId: created.id } };
  } catch (e) {
    // raw is ALWAYS a string — never a raw Error (T-5-LOG / D-06).
    return {
      ok: false,
      error: { kind: "unknown", raw: String((e as Error)?.message ?? e) },
    };
  }
}

/**
 * Confirm-summary seam (testable): validate the campaignId → userId-scoped
 * `getCampaignForUser` (cross-tenant/bogus id → not_found) → resolve the campaign's
 * OWN recipient set / template / SMTP config off its stored FKs (never a client
 * value) → read + parse the stored CSV server-side → recompute every gate
 * aggregate. Returns the ConfirmSummary the modal renders.
 *
 * SERVER-AUTHORITATIVE (T-5-TAMPER): the client passes ONLY a campaignId; the
 * recipient count, invalid-email count, missing-value row tally, unknown-token
 * union, sendable count, and merged sample are ALL recomputed here from the stored
 * CSV + template, so a tampered client payload can neither suppress a warning nor
 * bypass the gate. `senderIdentity` is derived from `toSmtpConfigDto`, which
 * structurally cannot carry the SMTP password (T-5-CRED).
 */
export async function buildConfirmSummaryCore(
  userId: string,
  input: ConfirmInput,
): Promise<SummaryResult> {
  const idParsed = campaignIdSchema.safeParse(input.campaignId);
  if (!idParsed.success) {
    return { ok: false, error: { kind: "validation", issues: idParsed.error.issues } };
  }

  // Owner-scoped campaign lookup — a cross-tenant/bogus id returns undefined.
  const campaign = await getCampaignForUser(userId, idParsed.data);
  if (!campaign) return { ok: false, error: { kind: "not_found" } };

  // Resolve the campaign's OWN FKs through the userId-scoped DALs — never a client
  // value. All three are NOT NULL, but resolve defensively.
  const set = await getRecipientSetForUser(userId, campaign.recipient_set_id);
  if (!set) return { ok: false, error: { kind: "not_found" } };
  const template = await getTemplateForUser(userId, campaign.template_id);
  if (!template) return { ok: false, error: { kind: "not_found" } };
  // Resolve the config from the campaign's OWN stamped FK (owner-scoped), NEVER a
  // client value (T-061-10) — mirrors how the set/template FKs already resolve.
  const cfg = await getSmtpConfigByIdForUser(userId, campaign.smtp_config_id);
  if (!cfg) return { ok: false, error: { kind: "not_found" } };

  // Read + parse the stored CSV server-side (storage_path came from the
  // userId-scoped row; readUpload also enforces the traversal boundary).
  let columns: string[];
  let rows: Record<string, string>[];
  try {
    const parsed = parseCsv(readUpload(set.storage_path));
    if (hasStructuralParseError(parsed.parseErrors)) {
      return { ok: false, error: { kind: "parse_error" } };
    }
    columns = parsed.columns;
    rows = parsed.rows;
  } catch (e) {
    return {
      ok: false,
      error: { kind: "unknown", raw: String((e as Error)?.message ?? e) },
    };
  }

  // The confirmed column is BOTH the sample's "To" and the invalid-count column,
  // so they can never diverge (T-4-DIVERGE parity).
  const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);
  const invalidEmailCount = emailColumn ? countInvalidEmails(rows, emailColumn) : 0;

  // Attachment presence/size — recomputed SERVER-SIDE via the SHARED matcher the
  // compose card also runs, so the confirm gate's numbers can never diverge from it
  // (T-07-09). We match the campaign's OWN stamped attachments (never a client set).
  // The column resolution is the SINGLE shared `resolveAttachmentColumn` helper the
  // compose matcher + worker also use (WR-03) — a saved choice wins, else auto-detect
  // that never co-opts the email column. This recomputes NOTHING by hand.
  const attachmentColumn = resolveAttachmentColumn(set, columns, rows);
  const uploaded = await listAttachmentsForCampaign(userId, campaign.id);
  const m = computeAttachmentMatch(columns, rows, attachmentColumn, uploaded);

  // Redacted sender identity — the DTO structurally omits the password triple.
  const dto = toSmtpConfigDto(cfg);
  const senderIdentity = dto.from_name
    ? `${dto.from_name} <${dto.from_addr}>`
    : dto.from_addr;

  // One merged sample for row 1 (empty/zero-safe when the CSV has no rows). The
  // merged fields are plain strings; the UI (Plan 04) renders them as escaped text.
  const firstRow = rows[0] ?? {};
  const merged = fillMessage(
    { subject: template.subject, body: template.body },
    firstRow,
  );
  const sample: ConfirmSummary["sample"] = {
    to: emailColumn ? (firstRow[emailColumn] ?? "") : "",
    subject: merged.subject,
    body: merged.body,
  };
  // The row-1 preview gains its attachment filename only when row 1 matched one.
  if (m.sampleAttachment) sample.attachment = m.sampleAttachment;

  // Merge-gap aggregates. rowsWithGaps counts rows with ≥1 blank merge value;
  // unknownTokens is row-independent (a token is unknown iff it is not a column),
  // so a single pass over the columns suffices and is cheaper than per-row union.
  const mergeSource = `${template.subject}\n${template.body}`;
  let rowsWithGaps = 0;
  for (const row of rows) {
    if (analyzeMerge(mergeSource, row, columns).empty.length > 0) rowsWithGaps++;
  }
  const columnSet = new Set(columns);
  const unknownTokens = extractTokens(mergeSource).filter(
    (token) => !columnSet.has(token),
  );

  const recipientCount = rows.length;
  const sendableCount = recipientCount - invalidEmailCount;

  return {
    ok: true,
    data: {
      campaignId: idParsed.data,
      recipientCount,
      senderIdentity,
      sample,
      invalidEmailCount,
      rowsWithGaps,
      unknownTokens,
      sendableCount,
      // Attachment aggregates straight from the shared matcher (no hand-recompute).
      attachmentColumn: m.attachmentColumn,
      rowsWithAttachment: m.rowsWithAttachment,
      attachmentTotal: m.attachmentTotal,
      missingAttachmentFilenames: m.missingAttachmentFilenames,
      missingAttachmentCount: m.missingAttachmentCount,
      oversizeRowCount: m.oversizeRowCount,
    },
  };
}

/**
 * Enqueue seam (testable): validate the campaignId → call the DAL's atomic
 * `enqueueCampaign(userId, id)` (single `UPDATE ... WHERE status='draft' AND
 * user_id=?`). The affected-row count IS the idempotency + IDOR signal: `!== 1`
 * (a double-submit on an already-queued row OR a cross-tenant/not-draft caller)
 * maps to the benign `already_queued`, never a second transition (TEST-03 /
 * T-5-DUPE / T-5-IDOR).
 */
export async function enqueueCampaignCore(
  userId: string,
  input: ConfirmInput,
): Promise<EnqueueResult> {
  const idParsed = campaignIdSchema.safeParse(input.campaignId);
  if (!idParsed.success) {
    return { ok: false, error: { kind: "validation", issues: idParsed.error.issues } };
  }

  // Server-side attachment gate BEFORE the flip (ATCH-02 / T-07-08): recompute the
  // campaign's own presence/size numbers via buildConfirmSummaryCore (which runs the
  // SHARED matcher against the campaign's STAMPED attachments) and BLOCK when any
  // referenced file is missing or any row is oversize. A dimmed client button is
  // never the gate — the block is enforced here, on the server. Because attachments
  // were stamped at PREPARE (not enqueue), this recheck reads the campaign's OWN
  // attachments, so a concurrent double-submit still sees them present and the block
  // cannot misfire; the atomic 0-row flip below still decides the single winner.
  //
  // The gate only lets a CLEAN summary flip the campaign (WR-04). A `not_found`
  // (cross-tenant / bogus id) is deliberately allowed to fall through to the atomic
  // DAL flip, whose 0-row guard yields the canonical `already_queued` for a
  // cross-tenant/not-draft caller (T-5-IDOR / TEST-03), exactly as before this gate
  // existed. But any OTHER summary failure — `parse_error`, `unknown` (a transient
  // readUpload / listAttachmentsForCampaign error) — must BLOCK the flip and return
  // the failure: enqueueing with the attachment gate un-run would (per CR-01) let
  // materialize deliver rows missing the file the gate never got to verify.
  const summary = await buildConfirmSummaryCore(userId, { campaignId: idParsed.data });
  if (!summary.ok && summary.error.kind !== "not_found") return summary;
  if (
    summary.ok &&
    (summary.data.missingAttachmentCount > 0 || summary.data.oversizeRowCount > 0)
  ) {
    return { ok: false, error: { kind: "attachments_blocked" } };
  }

  const flipped = await enqueueCampaignDal(userId, idParsed.data);
  if (flipped.length !== 1) {
    return { ok: false, error: { kind: "already_queued" } };
  }
  return { ok: true, data: { campaignId: idParsed.data } };
}

// --- Live-progress read seam (SEND-05) ---------------------------------------
//
// The single source of truth the polling UI (Plan 05) and the export route
// (Plan 06) read. It carries counts ONLY — never a send_record.error body (those
// are message-only strings by Plan-02 discipline, but the progress payload does
// not surface them at all) so nothing sensitive rides the client wire (T-06-10).

/**
 * The live-progress payload the polling client renders. `remaining` is derived
 * server-side (total − sent − failed) so the client never computes it; `current`
 * is the in-flight recipient's address (the lone 'sending' row) or null.
 */
export type ProgressData = {
  status: string;
  total: number;
  sent: number;
  failed: number;
  remaining: number;
  current: string | null;
};

/** Uniform result (never rejects). */
export type ProgressResult =
  | { ok: true; data: ProgressData }
  | { ok: false; error: ActionError };

/**
 * Progress seam (testable): validate the campaignId → userId-scoped
 * `getCampaignProgressRow` (cross-tenant/bogus id → undefined → not_found) →
 * shape the counts + derived `remaining` + current recipient. This module carries
 * NO "use server", so it can accept a caller-supplied userId without becoming a
 * client-invocable endpoint (T-06-09); actions.ts wraps it behind auth().
 */
export async function getCampaignProgressCore(
  userId: string,
  input: { campaignId: unknown },
): Promise<ProgressResult> {
  const idParsed = campaignIdSchema.safeParse(input.campaignId);
  if (!idParsed.success) {
    return { ok: false, error: { kind: "validation", issues: idParsed.error.issues } };
  }
  const row = await getCampaignProgressRow(userId, idParsed.data);
  if (!row) return { ok: false, error: { kind: "not_found" } };
  return {
    ok: true,
    data: {
      status: row.status,
      total: row.total,
      sent: row.sent_count,
      failed: row.failed_count,
      remaining: row.total - row.sent_count - row.failed_count,
      current: row.current,
    },
  };
}

// --- Delete seam (mdt) -------------------------------------------------------
//
// Operator-facing campaign delete. A draft/completed/failed campaign owned by the
// caller is removed together with its send_records + attachment rows (the DAL's
// transactional FK-ordered cascade), then its attachment FILES are unlinked
// post-commit (row-first). A queued/running campaign is BLOCKED (in_use) — never
// delete a campaign the worker may be processing (T-mdt-02).

/** The closed error surface the delete action returns (message-only). Broader than
 *  the core needs — the "use server" wrapper also emits unauthenticated/validation. */
export type DeleteCampaignError =
  | { kind: "unauthenticated" }
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found" }
  | { kind: "in_use" }
  | { kind: "unknown"; raw?: string };

/** The uniform result the delete seam + action resolve to (never rejects). */
export type DeleteCampaignResult =
  | { ok: true }
  | { ok: false; error: DeleteCampaignError };

/**
 * Delete seam (testable): userId-scoped pre-check → transactional cascade → unlink.
 *
 * Order: `getCampaignForUser` first (cross-tenant/bogus id → not_found; a
 * queued/running status → in_use, deleting nothing). Then the DAL's
 * `deleteCampaignForUser`, whose own status-guarded DELETE is the TOCTOU backstop:
 * if the campaign flipped to queued/running between the pre-check and the guarded
 * DELETE, the transaction refuses it and this maps the `{ ok:false }` to in_use.
 * On success each removed attachment's file is unlinked BEST-EFFORT — a failed
 * unlink leaves only a harmless disk-only file and never fails the action (the DB
 * rows are already gone; row-first discipline mirrors the worker's sweep).
 */
export async function deleteCampaignCore(
  userId: string,
  id: number,
): Promise<DeleteCampaignResult> {
  const campaign = await getCampaignForUser(userId, id);
  if (!campaign) return { ok: false, error: { kind: "not_found" } };
  if (campaign.status === "queued" || campaign.status === "running") {
    return { ok: false, error: { kind: "in_use" } };
  }

  const result = deleteCampaignForUser(userId, id);
  if (!result.ok) {
    // The guarded DELETE affected 0 rows — the campaign went active under us
    // (TOCTOU) or vanished. Treat the race as in_use; nothing was removed.
    return { ok: false, error: { kind: "in_use" } };
  }

  // Post-commit best-effort file cleanup — never fail the action on a unlink error.
  for (const storagePath of result.storagePaths) {
    try {
      deleteAttachment(storagePath);
    } catch {
      // A disk-only leftover is harmless (the rows are already gone).
    }
  }
  return { ok: true };
}
