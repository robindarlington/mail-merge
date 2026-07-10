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
    created_at: integer("created_at").notNull().default(unixNow),
  },
  // One SMTP config per user (D-09). This UNIQUE index is the on-disk conflict
  // target that makes `upsertSmtpConfig`'s onConflictDoUpdate(target userId)
  // atomic instead of a read-then-insert race (Pattern 5 / T-2-DUPE).
  (t) => [unique("smtp_configs_user_uq").on(t.userId)],
);

/**
 * recipient_sets — an uploaded CSV. columns_json drives editor autocomplete;
 * the file itself lives on the /data volume, referenced by storage_path.
 */
export const recipient_sets = sqliteTable("recipient_sets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  // JSON-encoded array of header names → merge-field autocomplete source.
  columns_json: text("columns_json").notNull(),
  row_count: integer("row_count").notNull(),
  storage_path: text("storage_path").notNull(),
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
  },
  (t) => [unique("send_records_campaign_addr_uq").on(t.campaign_id, t.to_addr)],
);

/**
 * attachments — per-row files (different file per CSV row). Bytes live on the
 * /data volume; only the path is stored. Tenancy inherited via campaign_id.
 */
export const attachments = sqliteTable("attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaign_id: integer("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  send_record_id: integer("send_record_id")
    .notNull()
    .references(() => send_records.id),
  filename: text("filename").notNull(),
  storage_path: text("storage_path").notNull(),
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
