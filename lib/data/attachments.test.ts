/**
 * Cross-tenant isolation + idempotent-stamp tests for the attachments DAL
 * (ATCH-01 / ATCH-03 / AUTH-02 / T-07-04 / T-07-17).
 *
 * These prove the tenancy invariant structurally: USER_B can never read, delete,
 * stamp, or column-set USER_A's data, and the campaign stamp is IDEMPOTENT across
 * re-prepares — a second draft re-claims the first draft's pending uploads, while
 * a row already committed to a queued campaign is never re-claimed.
 *
 * Pattern (mirrors lib/data/recipients.test.ts): set a temp `DATABASE_PATH` BEFORE
 * dynamically importing anything that transitively opens the DB, then build the
 * schema on that throwaway file via the committed migrations, seeding the full FK
 * chain (recipient set → template → smtp config → draft campaign) for both users.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Provision an isolated temp DB BEFORE any DB import -----------------------
const TMP_DIR = mkdtempSync(join(tmpdir(), "attachments-dal-"));
process.env.DATABASE_PATH = join(TMP_DIR, "app.db");

// Dynamic imports so the env var above is in effect at module-eval time.
const { db, connection } = await import("@/lib/db");
const {
  createAttachment,
  listPendingAttachmentsForUser,
  deleteAttachmentForUser,
  listAttachmentsForCampaign,
  stampCampaignOnPendingAttachments,
  getAttachmentByIdForCampaign,
} = await import("./attachments");
const {
  createRecipientSet,
  setAttachmentColumnForUser,
  getRecipientSetForUser,
} = await import("./recipients");
const { createTemplate } = await import("./templates");
const { createSmtpConfig } = await import("./smtp");
const { createDraftCampaign, enqueueCampaign } = await import("./campaigns");
const { encrypt } = await import("@/lib/crypto");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

const USER_A = "user_aaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user_bbbbbbbbbbbbbbbbbbbbbb";

/** Seed the full FK chain for a user and return a draft campaign id. */
async function seedDraftCampaign(userId: string, marker: string): Promise<number> {
  const [set] = await createRecipientSet(userId, {
    filename: `${marker}.csv`,
    columns_json: JSON.stringify(["email", "attachment"]),
    row_count: 2,
    storage_path: `${marker}.csv`,
    email_column: "email",
  });
  const [tpl] = await createTemplate(userId, { subject: "Hi", body: "Body" });
  const secret = encrypt("smtp-password");
  const [cfg] = await createSmtpConfig(userId, {
    label: "Default",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "sender",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "noreply@example.com",
    from_name: "Example Sender",
  });
  const [campaign] = await createDraftCampaign(userId, {
    recipient_set_id: set.id,
    template_id: tpl.id,
    smtp_config_id: cfg.id,
  });
  return campaign.id;
}

let A_SET_ID = 0;

before(async () => {
  migrate(db, { migrationsFolder: "./drizzle" });
  // Seed a recipient set for USER_A used by the attachment-column setter tests.
  const [set] = await createRecipientSet(USER_A, {
    filename: "a-set.csv",
    columns_json: JSON.stringify(["email", "file"]),
    row_count: 3,
    storage_path: "a-set.csv",
    email_column: "email",
  });
  A_SET_ID = set.id;
});

after(() => {
  connection.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test("createAttachment persists the server-supplied userId, nullable campaign_id, and returns the row", async () => {
  const [row] = await createAttachment(USER_A, {
    filename: "doc.pdf",
    storage_path: "uuid-1.bin",
    size_bytes: 1234,
  });
  assert.ok(row.id, "returned row carries a generated id");
  assert.equal(row.userId, USER_A, "userId is the server-supplied caller id");
  assert.equal(row.campaign_id, null, "campaign_id defaults null (pre-campaign)");
  assert.equal(row.filename, "doc.pdf");
  assert.equal(row.size_bytes, 1234);
});

test("listPendingAttachmentsForUser returns only the caller's unstamped uploads, newest first", async () => {
  await createAttachment(USER_B, {
    filename: "b.pdf",
    storage_path: "uuid-b.bin",
    size_bytes: 10,
  });
  const aPending = await listPendingAttachmentsForUser(USER_A);
  assert.ok(aPending.length >= 1, "USER_A sees their own pending uploads");
  assert.ok(
    aPending.every((a) => a.userId === USER_A),
    "list is scoped to the caller",
  );
  assert.ok(
    aPending.every((a) => a.campaign_id === null),
    "only unstamped (campaign_id IS NULL) uploads are pending",
  );
});

test("deleteAttachmentForUser cross-tenant deletes zero rows and leaves the row present (IDOR)", async () => {
  const [row] = await createAttachment(USER_A, {
    filename: "keep.pdf",
    storage_path: "uuid-keep.bin",
    size_bytes: 20,
  });
  const removed = await deleteAttachmentForUser(USER_B, row.id);
  assert.equal(removed.length, 0, "USER_B cannot delete USER_A's row");
  const stillThere = await listPendingAttachmentsForUser(USER_A);
  assert.ok(
    stillThere.some((a) => a.id === row.id),
    "USER_A's row survives a cross-tenant delete",
  );
  // Owner can delete their own row.
  const ownRemoved = await deleteAttachmentForUser(USER_A, row.id);
  assert.equal(ownRemoved.length, 1, "owner removes their own row");
});

test("stampCampaignOnPendingAttachments stamps only the caller's pending rows and returns them", async () => {
  const campaignId = await seedDraftCampaign(USER_A, "stamp-a");
  await createAttachment(USER_A, {
    filename: "s1.pdf",
    storage_path: "uuid-s1.bin",
    size_bytes: 5,
  });
  await createAttachment(USER_A, {
    filename: "s2.pdf",
    storage_path: "uuid-s2.bin",
    size_bytes: 6,
  });
  // A USER_B pending row that must NOT be claimed by USER_A's stamp.
  const [bRow] = await createAttachment(USER_B, {
    filename: "b-only.pdf",
    storage_path: "uuid-bonly.bin",
    size_bytes: 7,
  });

  const stamped = await stampCampaignOnPendingAttachments(USER_A, campaignId);
  assert.ok(stamped.length >= 2, "USER_A's pending rows are stamped");
  assert.ok(
    stamped.every((a) => a.userId === USER_A && a.campaign_id === campaignId),
    "every stamped row belongs to the caller and the target campaign",
  );

  // USER_B's row is untouched — still pending, never claimed.
  const bPending = await listPendingAttachmentsForUser(USER_B);
  assert.ok(
    bPending.some((a) => a.id === bRow.id),
    "USER_B's pending row is never claimed by USER_A's stamp",
  );

  // The stamped rows now surface via the campaign-scoped list for the owner.
  const forCampaign = await listAttachmentsForCampaign(USER_A, campaignId);
  assert.equal(forCampaign.length, stamped.length);
  // Cross-tenant campaign list returns nothing.
  const bView = await listAttachmentsForCampaign(USER_B, campaignId);
  assert.equal(bView.length, 0, "USER_B cannot list USER_A's campaign attachments");
});

test("stamp is IDEMPOTENT across re-prepares: a second draft re-claims the first draft's rows", async () => {
  const c1 = await seedDraftCampaign(USER_A, "reprepare-1");
  await createAttachment(USER_A, {
    filename: "r1.pdf",
    storage_path: "uuid-r1.bin",
    size_bytes: 8,
  });
  await createAttachment(USER_A, {
    filename: "r2.pdf",
    storage_path: "uuid-r2.bin",
    size_bytes: 9,
  });
  const firstStamp = await stampCampaignOnPendingAttachments(USER_A, c1);
  assert.ok(firstStamp.length >= 2, "first draft claims the pending rows");

  // Re-open the confirm dialog → a fresh draft campaign.
  const c2 = await seedDraftCampaign(USER_A, "reprepare-2");
  const secondStamp = await stampCampaignOnPendingAttachments(USER_A, c2);
  // The re-claim must move c1's still-draft rows onto c2.
  assert.ok(
    secondStamp.some((a) => firstStamp.some((f) => f.id === a.id)),
    "the second draft re-claims the first draft's attachments",
  );
  const c1After = await listAttachmentsForCampaign(USER_A, c1);
  assert.equal(c1After.length, 0, "the first draft is left with no attachments");
  const c2After = await listAttachmentsForCampaign(USER_A, c2);
  assert.ok(c2After.length >= 2, "the second draft now owns the attachments");
});

test("a row stamped to a queued (non-draft) campaign is NEVER re-claimed by a new draft", async () => {
  const committed = await seedDraftCampaign(USER_A, "committed");
  const [row] = await createAttachment(USER_A, {
    filename: "committed.pdf",
    storage_path: "uuid-committed.bin",
    size_bytes: 11,
  });
  await stampCampaignOnPendingAttachments(USER_A, committed);
  // Commit the campaign to a real send (draft → queued).
  await enqueueCampaign(USER_A, committed);

  // A new draft opened afterwards must NOT re-claim the committed row.
  const fresh = await seedDraftCampaign(USER_A, "fresh-after-commit");
  const stamped = await stampCampaignOnPendingAttachments(USER_A, fresh);
  assert.ok(
    !stamped.some((a) => a.id === row.id),
    "a queued campaign's attachment is never re-claimed",
  );
  const committedAfter = await listAttachmentsForCampaign(USER_A, committed);
  assert.ok(
    committedAfter.some((a) => a.id === row.id),
    "the committed campaign keeps its attachment",
  );
});

test("getAttachmentByIdForCampaign resolves the inverted link scoped by campaign_id", async () => {
  const campaignId = await seedDraftCampaign(USER_A, "resolver");
  const [row] = await createAttachment(USER_A, {
    filename: "resolve.pdf",
    storage_path: "uuid-resolve.bin",
    size_bytes: 12,
  });
  await stampCampaignOnPendingAttachments(USER_A, campaignId);

  const found = await getAttachmentByIdForCampaign(campaignId, row.id);
  assert.ok(found, "the worker resolver finds the campaign-scoped attachment");
  assert.equal(found.id, row.id);
  // A mismatched campaign_id resolves to not-found.
  const wrong = await getAttachmentByIdForCampaign(campaignId + 9999, row.id);
  assert.equal(wrong, undefined, "a mismatched campaign_id resolves to not-found");
});

test("setAttachmentColumnForUser persists the column for the owner and reads back", async () => {
  const [updated] = await setAttachmentColumnForUser(USER_A, A_SET_ID, "file");
  assert.ok(updated, "the owner's row is returned by the UPDATE");
  assert.equal(updated.attachment_column, "file");
  const reread = await getRecipientSetForUser(USER_A, A_SET_ID);
  assert.equal(reread?.attachment_column, "file", "the chosen column is persisted");
});

test("setAttachmentColumnForUser cross-tenant updates zero rows (IDOR)", async () => {
  const changed = await setAttachmentColumnForUser(USER_B, A_SET_ID, "hijacked");
  assert.equal(changed.length, 0, "USER_B cannot set USER_A's attachment column");
  const reread = await getRecipientSetForUser(USER_A, A_SET_ID);
  assert.notEqual(reread?.attachment_column, "hijacked", "the owner's column is unchanged");
});
