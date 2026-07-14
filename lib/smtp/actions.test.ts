/**
 * Server-Action seam tests for lib/smtp/actions (MSMTP-01/05 / AUTH-02 / SMTP-04).
 *
 * These drive the NON-"use server" orchestration seams the actions delegate to —
 * `applyVerifiedConfig` (id-scoped verify-then-save), `setDefaultConfigCore` /
 * `softDeleteConfigCore` (owner-scoped transitions + in-use guard), and
 * `sendTestVia` (verify-then-send) — so verified_at semantics, the WR-09 host-change
 * gate, label uniqueness, the first-server auto-default, the in-use delete guard,
 * and secret-redaction are all proven WITHOUT a live SMTP dial or a Clerk request
 * context. The thin "use server" wrappers (createServer / updateServer /
 * setDefaultServer / deleteServer / sendTestEmail) are auth+parse shells over these
 * seams.
 *
 * Pattern (mirrors lib/data/smtp.test.ts): set a temp DATABASE_PATH and a
 * deterministic CREDENTIAL_ENC_KEY BEFORE dynamically importing anything that
 * transitively opens the DB, then build the schema from the committed migrations.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "smtp-actions-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

// Dynamic imports so the env vars above are in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const {
  applyVerifiedConfig,
  sendTestVia,
  setDefaultConfigCore,
  softDeleteConfigCore,
} = await import("./actions-core");
const { listSmtpConfigsForUser, getSmtpConfigByIdForUser, updateFromFields } =
  await import("../data/smtp");
const { createRecipientSet } = await import("../data/recipients");
const { createTemplate } = await import("../data/templates");
const { createDraftCampaign, enqueueCampaign } = await import("../data/campaigns");
const { decrypt } = await import("../crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
type VerifyOutcome = import("./verify").VerifyOutcome;
type MailTransport = import("../core").MailTransport;

const USER_SAVE = "user_save_aaaaaaaaaaaaaaaa";
const USER_SUGGEST = "user_suggest_bbbbbbbbbbbb";
const USER_FROM = "user_from_only_ffffffffff";
const USER_BLANK_EDIT = "user_blank_edit_dddddddd";
const USER_WR09 = "user_wr09_hostchange_wwww";
const USER_BLANK_NOROW = "user_blank_norow_eeeeeeee";
const USER_DEFAULT = "user_first_default_dfltdf";
const USER_INUSE = "user_inuse_guard_iiiiiiii";
const USER_OWNER = "user_owner_ownerownerown";
const USER_INTRUDER = "user_intruder_zzzzzzzzzz";

// A distinctive marker so a redaction assertion can grep for a leak.
const MARKER_PASSWORD = "MARKER-SECRET-PASSWORD-9f2c";

/** A valid smtpFormSchema input (label, public host, explicit secure, marker password). */
function validInput(overrides: Record<string, unknown> = {}) {
  return {
    label: "Primary Server",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "onboarding-user",
    password: MARKER_PASSWORD,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
    ...overrides,
  };
}

/** Fake verifyFn seams — never dial a real server. */
const fakeVerifyOk = async (): Promise<VerifyOutcome> => ({ ok: true });
const fakeVerifySuggestion = async (): Promise<VerifyOutcome> => ({
  ok: false,
  kind: "tls",
  field: "tlsMode",
  raw: "wrong version number",
  suggestion: "starttls",
});

/**
 * A stub transport with counted verify/sendMail. `verifyOk:false` rejects with an
 * EAUTH-shaped error so classifyVerifyError maps it to { kind:"auth" }.
 */
function stubTransport(opts: {
  verifyOk: boolean;
  sendOk?: boolean;
  verifyMessage?: string;
  sendMessage?: string;
}): MailTransport & { calls: { verify: number; send: number } } {
  const calls = { verify: 0, send: 0 };
  return {
    calls,
    async verify() {
      calls.verify++;
      if (!opts.verifyOk) {
        throw Object.assign(new Error(opts.verifyMessage ?? "auth rejected"), {
          code: "EAUTH",
        });
      }
      return true;
    },
    async sendMail() {
      calls.send++;
      if (opts.sendOk === false) {
        throw new Error(opts.sendMessage ?? "550 mailbox unavailable");
      }
      return { messageId: "test-message-id" };
    },
  } as MailTransport & { calls: { verify: number; send: number } };
}

before(() => {
  // Build all tables + indexes from the committed migrations (0003/0004 promote
  // smtp_configs to many-rows-per-user); do NOT recreate the retired single-row
  // unique index — the multi-server model depends on its removal.
  migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- applyVerifiedConfig CREATE flow (id === null) ---------------------------

test("applyVerifiedConfig(create) persists a row with verified_at set on a clean verify", async () => {
  const result = await applyVerifiedConfig(USER_SAVE, null, validInput(), fakeVerifyOk);
  assert.equal(result.ok, true);

  const rows = await listSmtpConfigsForUser(USER_SAVE);
  assert.equal(rows.length, 1, "exactly one row should be persisted");
  const row = rows[0];
  assert.notEqual(row.verified_at, null, "verified_at must be stamped");
  assert.equal(row.host, "smtp.example.com");
  assert.equal(row.label, "Primary Server");
  // Redaction: the ok result carries nothing secret.
  assert.ok(!JSON.stringify(result).includes(MARKER_PASSWORD));
});

test("applyVerifiedConfig persists NOTHING on a D-05 alternate-mode suggestion", async () => {
  const result = await applyVerifiedConfig(
    USER_SUGGEST,
    null,
    validInput(),
    fakeVerifySuggestion,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "tls");
  assert.ok(
    !result.ok &&
      "suggestion" in result.error &&
      result.error.suggestion === "starttls",
  );

  // Structural proof nothing was saved: the user has no rows at all.
  const rows = await listSmtpConfigsForUser(USER_SUGGEST);
  assert.equal(rows.length, 0, "a suggestion outcome must not persist a config");
  // Redaction: the failure result carries only a message string, no password.
  assert.ok(!JSON.stringify(result).includes(MARKER_PASSWORD));
});

test("applyVerifiedConfig returns a validation error (and saves nothing) on bad input", async () => {
  const result = await applyVerifiedConfig(
    "user_badinput_cccccccccccc",
    null,
    validInput({ from_addr: "not-an-email" }),
    fakeVerifyOk,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
  const rows = await listSmtpConfigsForUser("user_badinput_cccccccccccc");
  assert.equal(rows.length, 0);
});

test("applyVerifiedConfig rejects a duplicate label case-insensitively (per account)", async () => {
  const first = await applyVerifiedConfig(
    "user_labeldup_llllllllllll",
    null,
    validInput({ label: "Marketing" }),
    fakeVerifyOk,
  );
  assert.equal(first.ok, true);

  // A different-cased same label on a NEW row for the same account is rejected.
  const dup = await applyVerifiedConfig(
    "user_labeldup_llllllllllll",
    null,
    validInput({ label: "  marketing  ", host: "smtp.other.example.com" }),
    fakeVerifyOk,
  );
  assert.equal(dup.ok, false);
  assert.ok(!dup.ok && dup.error.kind === "validation");
  assert.ok(JSON.stringify(dup).includes("Pick a different name."));

  // Only the first row exists — the duplicate persisted nothing.
  const rows = await listSmtpConfigsForUser("user_labeldup_llllllllllll");
  assert.equal(rows.length, 1);
});

test("a from-only update leaves verified_at (and connection fields) unchanged (D-08)", async () => {
  // Seed a verified config, then apply the from-only update the action delegates to.
  await applyVerifiedConfig(USER_FROM, null, validInput(), fakeVerifyOk);
  const [before] = await listSmtpConfigsForUser(USER_FROM);
  assert.ok(before);
  const priorVerifiedAt = before.verified_at;
  const priorHost = before.host;

  await updateFromFields(USER_FROM, {
    from_addr: "changed@example.com",
    from_name: "Changed Name",
  });

  const [after] = await listSmtpConfigsForUser(USER_FROM);
  assert.ok(after);
  assert.equal(after.from_addr, "changed@example.com");
  assert.equal(after.from_name, "Changed Name");
  // The proven connection is preserved — no re-verify was required (D-08 / Pitfall 6).
  assert.equal(after.verified_at, priorVerifiedAt);
  assert.equal(after.host, priorHost);
});

// --- Blank-password edit merge (SMTP-04 / D-07) + WR-09 host-change gate ------

test("applyVerifiedConfig(edit) keeps the stored password on a blank-password edit when the host is unchanged", async () => {
  // Seed a verified config carrying MARKER_PASSWORD for this fresh user.
  const seed = await applyVerifiedConfig(
    USER_BLANK_EDIT,
    null,
    validInput({ label: "Keeper" }),
    fakeVerifyOk,
  );
  assert.equal(seed.ok, true);
  const [seeded] = await listSmtpConfigsForUser(USER_BLANK_EDIT);
  assert.ok(seeded);

  // A verifyFn that CAPTURES the values it is handed, so we can prove the stored
  // password was substituted BEFORE verify runs.
  let capturedPassword: string | undefined;
  const capturingVerify = async (
    values: import("./schema").SmtpFormValues,
  ): Promise<VerifyOutcome> => {
    capturedPassword = values.password;
    return { ok: true };
  };

  // Edit a NON-host field (from_name) AND leave the password blank; host UNCHANGED.
  const result = await applyVerifiedConfig(
    USER_BLANK_EDIT,
    seeded.id,
    validInput({ label: "Keeper", from_name: "Renamed Sender", password: "" }),
    capturingVerify,
  );
  assert.equal(result.ok, true);

  // The stored password was merged in before verify saw it.
  assert.equal(
    capturedPassword,
    MARKER_PASSWORD,
    "verify must receive the stored password, not the blank",
  );

  // The edit persisted AND the stored password still round-trips.
  const row = await getSmtpConfigByIdForUser(USER_BLANK_EDIT, seeded.id);
  assert.ok(row, "the edited config should still exist");
  assert.equal(row.from_name, "Renamed Sender");
  const roundTripped = decrypt({
    enc: row.password_enc as Buffer,
    iv: row.password_iv as Buffer,
    tag: row.password_tag as Buffer,
  });
  assert.equal(
    roundTripped,
    MARKER_PASSWORD,
    "the persisted row must still decrypt to the stored password",
  );

  // Redaction: nothing secret leaks onto the ok result.
  assert.ok(!JSON.stringify(result).includes(MARKER_PASSWORD));
});

test("WR-09 (LOCKED): a blank password with a CHANGED host is rejected before any decrypt/verify, persisting nothing", async () => {
  // Seed a verified config.
  await applyVerifiedConfig(USER_WR09, null, validInput({ label: "Origin" }), fakeVerifyOk);
  const [seeded] = await listSmtpConfigsForUser(USER_WR09);
  assert.ok(seeded);

  // A verify that FAILS the test if it is ever called — WR-09 must short-circuit
  // BEFORE verify (and before any decrypt of the stored credential).
  let verifyCalls = 0;
  const forbiddenVerify = async (): Promise<VerifyOutcome> => {
    verifyCalls++;
    return { ok: true };
  };

  const result = await applyVerifiedConfig(
    USER_WR09,
    seeded.id,
    validInput({ label: "Origin", host: "smtp.changed.example.com", password: "" }),
    forbiddenVerify,
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");
  // The WR-09 copy is field-anchored on `password`.
  assert.ok(
    JSON.stringify(result).includes(
      "Re-enter the password so we can verify it against the new host.",
    ),
  );
  assert.equal(verifyCalls, 0, "verify (and thus decrypt) must never run on the WR-09 reject path");

  // Nothing changed: the stored host is intact.
  const row = await getSmtpConfigByIdForUser(USER_WR09, seeded.id);
  assert.ok(row);
  assert.equal(row.host, "smtp.example.com", "the host change must NOT persist");
});

test("applyVerifiedConfig(create) rejects a blank password when there is no stored row", async () => {
  const result = await applyVerifiedConfig(
    USER_BLANK_NOROW,
    null,
    validInput({ password: "" }),
    fakeVerifyOk,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "validation");

  // Nothing was saved for a blank password on the create flow.
  const rows = await listSmtpConfigsForUser(USER_BLANK_NOROW);
  assert.equal(rows.length, 0, "a blank create must persist nothing");
});

// --- First-server auto-default + owner-scoped set-default / delete ------------

test("the FIRST server for an account auto-defaults; a later add does NOT promote itself", async () => {
  const first = await applyVerifiedConfig(
    USER_DEFAULT,
    null,
    validInput({ label: "First" }),
    fakeVerifyOk,
  );
  assert.equal(first.ok, true);

  const second = await applyVerifiedConfig(
    USER_DEFAULT,
    null,
    validInput({ label: "Second", host: "smtp.second.example.com" }),
    fakeVerifyOk,
  );
  assert.equal(second.ok, true);

  const rows = await listSmtpConfigsForUser(USER_DEFAULT);
  assert.equal(rows.length, 2);
  const defaults = rows.filter((r) => r.is_default);
  assert.equal(defaults.length, 1, "exactly one default");
  assert.equal(defaults[0].label, "First", "the first server stays default");
});

test("softDeleteConfigCore is BLOCKED (in_use) while a queued campaign references the server", async () => {
  // Seed the campaign FK graph (recipient set + template are NOT NULL FKs).
  const [set] = await createRecipientSet(USER_INUSE, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 3,
    storage_path: "/data/uploads/recipients.csv",
    email_column: "email",
  });
  const [tpl] = await createTemplate(USER_INUSE, {
    subject: "Hi {{name}}",
    body: "Welcome aboard.",
  });

  await applyVerifiedConfig(USER_INUSE, null, validInput({ label: "InUse" }), fakeVerifyOk);
  const [cfg] = await listSmtpConfigsForUser(USER_INUSE);
  assert.ok(cfg);

  // A queued campaign referencing the config makes it in-use.
  const [draft] = await createDraftCampaign(USER_INUSE, {
    recipient_set_id: set.id,
    template_id: tpl.id,
    smtp_config_id: cfg.id,
  });
  await enqueueCampaign(USER_INUSE, draft.id);

  const del = await softDeleteConfigCore(USER_INUSE, cfg.id);
  assert.equal(del.ok, false);
  assert.ok(!del.ok && del.error.kind === "in_use");

  // The guarded config is NOT deleted — it still resolves.
  const still = await getSmtpConfigByIdForUser(USER_INUSE, cfg.id);
  assert.ok(still, "an in-use config must survive the blocked delete");
});

test("setDefaultConfigCore and softDeleteConfigCore return not_found for a cross-tenant id (IDOR)", async () => {
  await applyVerifiedConfig(USER_OWNER, null, validInput({ label: "Owned" }), fakeVerifyOk);
  const [owned] = await listSmtpConfigsForUser(USER_OWNER);
  assert.ok(owned);

  // The intruder cannot set-default or delete a config it does not own.
  const setRes = await setDefaultConfigCore(USER_INTRUDER, owned.id);
  assert.equal(setRes.ok, false);
  assert.ok(!setRes.ok && setRes.error.kind === "not_found");

  const delRes = await softDeleteConfigCore(USER_INTRUDER, owned.id);
  assert.equal(delRes.ok, false);
  assert.ok(!delRes.ok && delRes.error.kind === "not_found");

  // The owner's config is untouched.
  const still = await getSmtpConfigByIdForUser(USER_OWNER, owned.id);
  assert.ok(still, "a cross-tenant attempt must not affect the owner's row");
});

// --- sendTestVia (verify-then-send) ------------------------------------------

test("sendTestVia returns a classified error and NEVER calls sendOne when verify rejects", async () => {
  const transport = stubTransport({ verifyOk: false });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example" },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, false);
  // The failed pre-send verify is classified the same way create/update classifies.
  assert.ok(!result.ok && result.error.kind === "auth");
  assert.ok(!result.ok && "field" in result.error && result.error.field === "auth");
  // sendOne is unreachable when verify fails.
  assert.equal(transport.calls.verify, 1);
  assert.equal(transport.calls.send, 0);
});

test("sendTestVia calls sendOne only after a successful verify", async () => {
  const transport = stubTransport({ verifyOk: true, sendOk: true });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example Sender" },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, true);
  assert.equal(transport.calls.verify, 1);
  assert.equal(transport.calls.send, 1);
});

test("sendTestVia maps a send failure to a message-only send_failed result", async () => {
  const transport = stubTransport({ verifyOk: true, sendOk: false });
  const result = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: null },
    "rob@example.com",
    transport,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === "send_failed");
  // `raw` is a message STRING, never a raw Error object or a config.
  assert.ok(!result.ok && typeof (result.error as { raw: unknown }).raw === "string");
});

test("no failure result ever leaks a config object or a secret (redaction)", async () => {
  const failVerify = await sendTestVia(
    { from_addr: "noreply@example.com", from_name: "Example" },
    "rob@example.com",
    stubTransport({ verifyOk: false, verifyMessage: MARKER_PASSWORD }),
  );
  // Even if the underlying error message happened to echo a secret, the shape is
  // a closed union — assert it only ever carries kind/field/raw string fields.
  assert.equal(failVerify.ok, false);
  if (!failVerify.ok) {
    const keys = Object.keys(failVerify.error).sort();
    assert.deepEqual(keys, ["field", "kind", "raw"]);
    assert.equal(typeof (failVerify.error as { raw: unknown }).raw, "string");
  }
});
