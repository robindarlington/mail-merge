/**
 * Full v1 Drizzle schema (D-05) — all six entities defined up front.
 *
 * Authoritative entity model: .planning/research/ARCHITECTURE.md
 * "Entities (SQLite data model)" + the campaign/send_record state machines.
 *
 * Conventions:
 *  - Timestamps are INTEGER unixepoch seconds (`$defaultFn(() => unixepoch)`),
 *    matching the research model's INTEGER columns.
 *  - `status` columns are TEXT carrying the documented state-machine values.
 *  - `secure` is an integer-backed boolean — stored EXPLICITLY, never inferred
 *    from port (SMTP-04 / PITFALLS #3, fixes the CLI `port === 465` anti-pattern).
 *  - SMTP credentials are stored ONLY as the AES-256-GCM triple
 *    (password_enc / password_iv / password_tag). No plaintext password column
 *    exists anywhere (PITFALLS #1/#2).
 *  - Every tenant-owned table carries `userId` (Clerk id) for multi-tenant
 *    scoping (AUTH-02 / PITFALLS #13). send_records and attachments inherit
 *    tenancy through their campaign_id FK.
 *
 * This file is read by drizzle-kit (drizzle.config.ts) to generate migrations.
 * Migrations are generated/applied in plan 01-05, not here.
 */

import { sql, type InferSelectModel, type InferInsertModel } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  blob,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** unixepoch-seconds default for INTEGER timestamp columns. */
const unixNow = sql`(unixepoch())`;

/**
 * smtp_configs — one BYO-SMTP credential set per user.
 * Stores host/port/from in plaintext (for display) but the password ONLY as the
 * encrypted AES-256-GCM triple. `secure` is explicit (SMTP-04).
 */
export const smtp_configs = sqliteTable(
  "smtp_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    // Explicit TLS mode — NOT inferred from port (PITFALLS #3).
    secure: integer("secure", { mode: "boolean" }).notNull(),
    username: text("username").notNull(),
    // AES-256-GCM ciphertext parts — the ONLY representation of the password.
    password_enc: blob("password_enc").notNull(),
    password_iv: blob("password_iv").notNull(),
    password_tag: blob("password_tag").notNull(),
    from_addr: text("from_addr").notNull(),
    from_name: text("from_name"),
    // Set when transport.verify() succeeded during onboarding.
    verified_at: integer("verified_at"),
    // User-facing name for this server (many-per-user, 06.1). Nullable until the
    // 0004 backfill stamps surviving pre-06.1 rows with 'Default'.
    label: text("label"),
    // Exactly one default server per user — the partial unique index below is the
    // structural backstop. Integer-backed boolean (copies the `secure` idiom).
    is_default: integer("is_default", { mode: "boolean" }).notNull().default(false),
    // Soft-delete tombstone: set on delete so the row survives for campaign
    // history while disappearing from list/by-id reads. Nullable timestamp idiom
    // (copies `verified_at`).
    deleted_at: integer("deleted_at"),
    created_at: integer("created_at").notNull().default(unixNow),
  },
  // Many named SMTP configs per user (06.1) — the old single-row unique index is
  // gone. A PARTIAL unique index enforces at most one is_default=1 row per user;
  // non-default rows are unconstrained, so a user can hold arbitrarily many.
  (t) => [
    uniqueIndex("smtp_configs_user_default_uq")
      .on(t.userId)
      .where(sql`${t.is_default} = 1`),
  ],
);

/**
 * recipient_sets — an uploaded CSV. columns_json drives editor autocomplete;
 * the file itself lives on the /data volume, referenced by storage_path.
 */
export const recipient_sets = sqliteTable("recipient_sets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  // User-facing display name for this list (r8d). Nullable and never backfilled —
  // existing rows keep NULL and the UI shows `label ?? filename`, so the original
  // CSV filename is always preserved for reference. Mirrors smtp_configs.label.
  label: text("label"),
  // JSON-encoded array of header names → merge-field autocomplete source.
  columns_json: text("columns_json").notNull(),
  row_count: integer("row_count").notNull(),
  storage_path: text("storage_path").notNull(),
  // The user-confirmed email column (CSV-03/05). The save path ALWAYS writes
  // this, so Phase 5/6 sends against the column the user chose — never a
  // re-run of detectEmailColumn that would silently drop an override. Nullable
  // (like from_name/verified_at) because it was added additively: the single
  // pre-existing dev row predates the confirm step and has no known value.
  email_column: text("email_column"),
  // The user-confirmed attachment-filename column (ATCH-01). Same contract as
  // email_column above: the save path ALWAYS writes this, so the send path uses
  // the column the user chose — never a re-run of detectAttachmentColumn that
  // would silently drop an override. Nullable additive column (like
  // email_column): pre-existing rows predate the attachment step and hold NULL.
  attachment_column: text("attachment_column"),
  created_at: integer("created_at").notNull().default(unixNow),
});

/**
 * templates — a composed plain-text email. subject MAY contain {{fields}}
 * (fixes the CLI's unpersonalized-subject gap); body holds {{field}} tokens.
 */
export const templates = sqliteTable("templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  created_at: integer("created_at").notNull().default(unixNow),
});

/**
 * campaigns — the unit of work / the job row. The worker claims a `queued`
 * campaign, leases it, and walks its send_records.
 * status: draft | queued | running | completed | failed
 */
export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  recipient_set_id: integer("recipient_set_id")
    .notNull()
    .references(() => recipient_sets.id),
  template_id: integer("template_id")
    .notNull()
    .references(() => templates.id),
  smtp_config_id: integer("smtp_config_id")
    .notNull()
    .references(() => smtp_configs.id),
  status: text("status").notNull().default("draft"),
  worker_id: text("worker_id"),
  lease_expires_at: integer("lease_expires_at"),
  total: integer("total").notNull().default(0),
  sent_count: integer("sent_count").notNull().default(0),
  failed_count: integer("failed_count").notNull().default(0),
  created_at: integer("created_at").notNull().default(unixNow),
  started_at: integer("started_at"),
  finished_at: integer("finished_at"),
});

/**
 * send_records — one row PER recipient PER campaign: the per-recipient state
 * machine (pending → sending → sent | failed) and durable audit trail.
 * UNIQUE(campaign_id, to_addr) makes materialization idempotent (SEND-06).
 * Tenancy is inherited via campaign_id (no userId column here by design).
 */
export const send_records = sqliteTable(
  "send_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    to_addr: text("to_addr").notNull(),
    // Snapshot of exactly what was/will-be sent.
    merged_subject: text("merged_subject").notNull(),
    merged_body: text("merged_body").notNull(),
    status: text("status").notNull().default("pending"),
    message_id: text("message_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    sent_at: integer("sent_at"),
    // The per-row attachment link (ATCH-01). NULLABLE: many send_records → one
    // attachment; a file referenced by many CSV rows is linked from each row's
    // send_record, not the other way around. Stamped at materialize (Plan 04); a
    // blank attachment cell leaves this null (send without attachment).
    attachment_id: integer("attachment_id").references(() => attachments.id),
  },
  (t) => [unique("send_records_campaign_addr_uq").on(t.campaign_id, t.to_addr)],
);

/**
 * attachments — per-row files (different file per CSV row). Bytes live on the
 * /data volume; only the path is stored.
 *
 * PRE-CAMPAIGN WINDOW (ATCH-01): a file is uploaded on /compose BEFORE
 * prepareCampaignCore creates the campaign row, so `campaign_id` is NULLABLE and
 * gets stamped later at prepare time (mirroring how recipient_sets.email_column
 * was added nullable-additively). Because AUTH-02 tenancy-via-campaign only works
 * once campaign_id is set, the table carries a direct owner column `user_id` for
 * the pre-campaign window — every DAL read/write scopes on it.
 *
 * LINK INVERSION (ATCH-01): there is NO send_record_id here. A file referenced by
 * many CSV rows must link EVERY one of them, so the row↔attachment FK lives on
 * send_records.attachment_id (many send_records → one attachment). A per-
 * attachment send_record_id could only ever point at one row (last-stamped-wins,
 * earlier rows silently sent without their file).
 *
 * `size_bytes` is persisted so the 15MB per-message validation sums row sizes
 * without stat-ing disk per row.
 */
export const attachments = sqliteTable("attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Direct owner scope for the pre-campaign window (AUTH-02 grep gate).
  userId: text("user_id").notNull(),
  // NULLABLE until prepareCampaignCore stamps it (uploaded before the campaign).
  campaign_id: integer("campaign_id").references(() => campaigns.id),
  filename: text("filename").notNull(),
  storage_path: text("storage_path").notNull(),
  // Persisted upload size — the per-message (15MB) validation sums these.
  size_bytes: integer("size_bytes").notNull(),
  created_at: integer("created_at").notNull().default(unixNow),
});

// --- Typed row models for downstream phases ---------------------------------

export type SmtpConfig = InferSelectModel<typeof smtp_configs>;
export type NewSmtpConfig = InferInsertModel<typeof smtp_configs>;

export type RecipientSet = InferSelectModel<typeof recipient_sets>;
export type NewRecipientSet = InferInsertModel<typeof recipient_sets>;

export type Template = InferSelectModel<typeof templates>;
export type NewTemplate = InferInsertModel<typeof templates>;

export type Campaign = InferSelectModel<typeof campaigns>;
export type NewCampaign = InferInsertModel<typeof campaigns>;

export type SendRecord = InferSelectModel<typeof send_records>;
export type NewSendRecord = InferInsertModel<typeof send_records>;

export type Attachment = InferSelectModel<typeof attachments>;
export type NewAttachment = InferInsertModel<typeof attachments>;
