/**
 * Worker maintenance-routine tests (SC-4 / RESEARCH Finding 4).
 *
 * Two idle-aware operational routines, proven against a temp DB WITHOUT spinning
 * the poll loop:
 *
 *  1. checkpointWal — runs `wal_checkpoint(TRUNCATE)`, RETURNS the pragma's
 *     `{busy, log, checkpointed}` row, and logs it. A `busy:1` result (a reader
 *     held a snapshot the whole time, so the WAL did NOT shrink) is returned and
 *     logged, never thrown (PITFALLS #7 — never assume the WAL shrank).
 *
 *  2. sweepOrphanAttachments — deletes ONLY attachments that are (a) unstamped
 *     (`campaign_id IS NULL`) OR (b) stamped to a `draft` campaign, AND older than
 *     `orphanDays`. It must NEVER touch a recent orphan or a row belonging to a
 *     queued/running/completed/failed campaign. The DB row is deleted FIRST (the
 *     DB is the source of truth for the pending-bytes quota), THEN the file is
 *     unlinked — a failed unlink counts as `unlinkFailures` and leaves a
 *     harmless disk-only file. Logs COUNTS ONLY, never a filename/path/userId
 *     (T-08-08 information-disclosure mitigation).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB + encryption key BEFORE any DB import ------
const TMP_DIR = mkdtempSync(join(tmpdir(), "worker-maintenance-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");
// UPLOADS_PATH must be pinned BEFORE lib/attachments/storage is imported — the
// module resolves it once at load. The integration test below writes REAL files
// here and sweeps them with the production unlink wiring (CR-01 regression).
const UPLOADS_DIR = join(TMP_DIR, "uploads");
process.env.UPLOADS_PATH = UPLOADS_DIR;
process.env.CREDENTIAL_ENC_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

const { db, connection, attachments, campaigns } = await import("@/lib/db");
const { resolveAttachmentPath } = await import("@/lib/attachments/storage");
const { checkpointWal, sweepOrphanAttachments, isDue } = await import(
  "./maintenance"
);
const { createRecipientSet } = await import("@/lib/data/recipients");
const { createTemplate } = await import("@/lib/data/templates");
const { createSmtpConfig } = await import("@/lib/data/smtp");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { eq } = await import("drizzle-orm");

const USER = "user_maintenance_tenant_bbbbbb";

// A FIXED clock (unix seconds) so the age filter is deterministic — never
// wall-clock (WR-tests must not depend on real time).
const NOW = 1_700_000_000;
const DAY = 86_400;
const ORPHAN_DAYS = 7;

let RECIPIENT_SET_ID = 0;
let TEMPLATE_ID = 0;
let SMTP_CONFIG_ID = 0;

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });

  const [set] = await createRecipientSet(USER, {
    filename: "recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: 3,
    storage_path: "/data/uploads/recipients.csv",
    email_column: "email",
  });
  RECIPIENT_SET_ID = set.id;

  const [tpl] = await createTemplate(USER, {
    subject: "Hi {{name}}",
    body: "Welcome aboard.",
  });
  TEMPLATE_ID = tpl.id;

  const secret = encrypt("MARKER-SECRET-PASSWORD-maintenance");
  const [cfg] = await createSmtpConfig(USER, {
    label: "Default",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "onboarding-user",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
    is_default: true,
  });
  SMTP_CONFIG_ID = cfg.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** A fake logger that captures every call so tests can assert on log payloads. */
function makeLogger() {
  const calls: { obj: Record<string, unknown>; msg?: string }[] = [];
  const log = (obj: Record<string, unknown>, msg?: string) =>
    calls.push({ obj, msg });
  return { logger: { info: log, warn: log }, calls };
}

/** Insert a campaign row with a chosen status; returns its id. */
function insertCampaign(status: string): number {
  const [row] = db
    .insert(campaigns)
    .values({
      userId: USER,
      recipient_set_id: RECIPIENT_SET_ID,
      template_id: TEMPLATE_ID,
      smtp_config_id: SMTP_CONFIG_ID,
      status,
    })
    .returning({ id: campaigns.id })
    .all();
  return row.id;
}

let attachSeq = 0;
/** Insert an attachment with a chosen campaign link + age (days before NOW). */
function insertAttachment(opts: {
  campaignId: number | null;
  ageDays: number;
  path?: string;
}): number {
  attachSeq += 1;
  const [row] = db
    .insert(attachments)
    .values({
      userId: USER,
      campaign_id: opts.campaignId,
      filename: `secret-file-${attachSeq}.pdf`,
      // RELATIVE opaque name — matches the production contract
      // (lib/attachments/storage stores `<uuid>.bin`, never an absolute path).
      // Absolute test paths previously masked the CR-01 resolution bug.
      storage_path: opts.path ?? `secret-${attachSeq}.bin`,
      size_bytes: 1234,
      created_at: NOW - opts.ageDays * DAY,
    })
    .returning({ id: attachments.id })
    .all();
  return row.id;
}

/** Does an attachment row still exist? */
function attachExists(id: number): boolean {
  return (
    db.select().from(attachments).where(eq(attachments.id, id)).all().length ===
    1
  );
}

// --- checkpointWal -----------------------------------------------------------

test("checkpointWal runs TRUNCATE, returns the pragma row, and logs {busy,log,checkpointed}", () => {
  const { logger, calls } = makeLogger();
  const row = checkpointWal(connection, logger);

  assert.equal(typeof row.busy, "number", "busy is a number");
  assert.equal(typeof row.log, "number", "log is a number");
  assert.equal(typeof row.checkpointed, "number", "checkpointed is a number");

  const logged = calls.find((c) => c.obj.checkpointed !== undefined);
  assert.ok(logged, "logged the checkpoint result row");
  assert.ok(logged!.obj.busy !== undefined, "logged busy");
  assert.ok(logged!.obj.log !== undefined, "logged log size");
});

test("checkpointWal returns+logs a busy:1 result without throwing (WAL did NOT shrink)", () => {
  const { logger, calls } = makeLogger();
  // Fake connection: a reader held a snapshot, so TRUNCATE could not run.
  const fakeConn = {
    pragma: (_s: string) => [{ busy: 1, log: 42, checkpointed: 0 }],
  } as unknown as typeof connection;

  const row = checkpointWal(fakeConn, logger);
  assert.equal(row.busy, 1, "busy:1 is returned, not thrown");
  assert.equal(row.log, 42);
  assert.equal(row.checkpointed, 0);
  assert.ok(
    calls.some((c) => c.obj.busy === 1),
    "the busy:1 result was logged so the operator sees the WAL did not shrink",
  );
});

// --- sweepOrphanAttachments: selectivity -------------------------------------

test("sweep deletes ONLY aged unstamped + aged draft-stamped attachments", () => {
  const draft = insertCampaign("draft");
  const queued = insertCampaign("queued");
  const running = insertCampaign("running");
  const completed = insertCampaign("completed");
  const failed = insertCampaign("failed");

  const agedUnstamped = insertAttachment({ campaignId: null, ageDays: 10 }); // DELETE
  const recentUnstamped = insertAttachment({ campaignId: null, ageDays: 1 }); // keep
  const agedDraft = insertAttachment({ campaignId: draft, ageDays: 10 }); // DELETE
  const recentDraft = insertAttachment({ campaignId: draft, ageDays: 1 }); // keep
  const agedQueued = insertAttachment({ campaignId: queued, ageDays: 30 }); // keep
  const agedRunning = insertAttachment({ campaignId: running, ageDays: 30 }); // keep
  const agedCompleted = insertAttachment({
    campaignId: completed,
    ageDays: 30,
  }); // keep
  const agedFailed = insertAttachment({ campaignId: failed, ageDays: 30 }); // keep

  const unlinked: string[] = [];
  const { logger } = makeLogger();
  const res = sweepOrphanAttachments({
    db,
    now: NOW,
    orphanDays: ORPHAN_DAYS,
    unlink: (p) => {
      unlinked.push(p);
    },
    logger,
  });

  assert.equal(res.deletedRows, 2, "exactly the two aged orphans are deleted");
  assert.equal(res.deletedFiles, 2, "both files unlinked");
  assert.equal(res.unlinkFailures, 0);

  assert.equal(attachExists(agedUnstamped), false, "aged unstamped deleted");
  assert.equal(attachExists(agedDraft), false, "aged draft-stamped deleted");

  assert.equal(attachExists(recentUnstamped), true, "recent unstamped kept");
  assert.equal(attachExists(recentDraft), true, "recent draft-stamped kept");
  assert.equal(attachExists(agedQueued), true, "queued campaign's file kept");
  assert.equal(attachExists(agedRunning), true, "running campaign's file kept");
  assert.equal(
    attachExists(agedCompleted),
    true,
    "completed campaign's file kept",
  );
  assert.equal(attachExists(agedFailed), true, "failed campaign's file kept");
});

// --- sweepOrphanAttachments: row-first ordering ------------------------------

test("deletes the DB row BEFORE unlinking; an unlink failure increments unlinkFailures and leaves no row", () => {
  const orphan = insertAttachment({
    campaignId: null,
    ageDays: 10,
    path: "will-fail.bin",
  });

  const { logger } = makeLogger();
  let rowGoneWhenUnlinkRan = false;
  const res = sweepOrphanAttachments({
    db,
    now: NOW,
    orphanDays: ORPHAN_DAYS,
    unlink: () => {
      // Row-first invariant: at unlink time the DB row is ALREADY gone.
      rowGoneWhenUnlinkRan = !attachExists(orphan);
      throw new Error("EPERM: unlink denied");
    },
    logger,
  });

  assert.equal(
    rowGoneWhenUnlinkRan,
    true,
    "the DB row was committed-deleted before the unlink was attempted",
  );
  assert.equal(res.deletedRows, 1, "the row counts as deleted");
  assert.equal(res.deletedFiles, 0, "the file was not unlinked");
  assert.equal(res.unlinkFailures, 1, "the unlink failure was counted");
  assert.equal(
    attachExists(orphan),
    false,
    "the row stays gone even though the file remained on disk",
  );
});

// --- sweepOrphanAttachments: PRODUCTION unlink wiring (CR-01 regression) ------

test("production wiring deletes the REAL file for a RELATIVE storage_path under UPLOADS_PATH", () => {
  // Seed a real file under the temp UPLOADS_PATH using the RELATIVE opaque name
  // exactly as lib/attachments/storage stores it. The sweep must resolve that
  // relative name against UPLOADS_PATH (via resolveAttachmentPath) — a bare
  // unlinkSync(storage_path) resolves against the process CWD, ENOENTs, and
  // leaves the file permanently untracked (the CR-01 disk leak).
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const relName = "cr01-regression.bin";
  const absPath = join(UPLOADS_DIR, relName);
  writeFileSync(absPath, "payload");
  const orphan = insertAttachment({ campaignId: null, ageDays: 10, path: relName });

  const { logger } = makeLogger();
  const res = sweepOrphanAttachments({
    db,
    now: NOW,
    orphanDays: ORPHAN_DAYS,
    // EXACT production wiring from worker/index.ts — resolve then unlink.
    unlink: (p) => unlinkSync(resolveAttachmentPath(p)),
    logger,
  });

  assert.equal(res.unlinkFailures, 0, "the real unlink succeeded (no ENOENT)");
  assert.equal(res.deletedFiles >= 1, true, "the file counted as deleted");
  assert.equal(attachExists(orphan), false, "the DB row is gone");
  assert.equal(existsSync(absPath), false, "the REAL file is gone from the uploads dir");
});

test("production wiring rejects a traversal storage_path without touching disk", () => {
  const outside = join(TMP_DIR, "escape-me.bin");
  writeFileSync(outside, "must survive");
  const orphan = insertAttachment({
    campaignId: null,
    ageDays: 10,
    path: "../escape-me.bin", // hostile/corrupt DB content — must be rejected
  });

  const { logger } = makeLogger();
  const res = sweepOrphanAttachments({
    db,
    now: NOW,
    orphanDays: ORPHAN_DAYS,
    unlink: (p) => unlinkSync(resolveAttachmentPath(p)),
    logger,
  });

  assert.equal(res.unlinkFailures >= 1, true, "the traversal path counted as a failure");
  assert.equal(existsSync(outside), true, "the file OUTSIDE the uploads dir was NOT deleted");
  assert.equal(attachExists(orphan), false, "the hostile row itself is still removed");
});

// --- sweepOrphanAttachments: count-only logging ------------------------------

test("logs COUNTS ONLY — never a filename, storage path, or userId", () => {
  const secretPath = "TOP-SECRET-USER-DATA.bin";
  insertAttachment({ campaignId: null, ageDays: 10, path: secretPath });

  const { logger, calls } = makeLogger();
  sweepOrphanAttachments({
    db,
    now: NOW,
    orphanDays: ORPHAN_DAYS,
    unlink: () => {},
    logger,
  });

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(secretPath), "no storage path in any log");
  assert.ok(!serialized.includes("TOP-SECRET"), "no filename in any log");
  assert.ok(!serialized.includes(USER), "no userId in any log");

  assert.ok(
    calls.some((c) => c.obj.deletedRows !== undefined),
    "the count fields WERE logged",
  );
});

// --- isDue scheduler seam ----------------------------------------------------

test("isDue returns true only once the interval has elapsed since lastAt", () => {
  assert.equal(isDue(0, 1000, 1000), true, "never-run (0) fires once due");
  assert.equal(isDue(5000, 1000, 5999), false, "not yet elapsed");
  assert.equal(isDue(5000, 1000, 6000), true, "exactly elapsed");
  assert.equal(isDue(5000, 1000, 9000), true, "well past due");
});
