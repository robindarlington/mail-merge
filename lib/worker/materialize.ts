/**
 * lib/worker/materialize — turn a claimed campaign's stored CSV + template into
 * one `pending` `send_record` per UNIQUE recipient address, idempotently.
 *
 * This is Pattern 2 from the phase research (ARCHITECTURE Pattern 3): after a
 * campaign is claimed, materialize its recipients up front so the send loop can
 * process rows that already exist. It composes the ALREADY-TESTED pure primitives
 * (`parseCsv` / `detectEmailColumn` / `fillMessage` from lib/core, `readUpload`
 * from lib/csv) and the userId-scoped DAL — it re-implements NONE of them (the
 * "no new merge/CSV code" review rule, Phase 5 PATTERNS).
 *
 * Two correctness properties:
 *  - Idempotent on resume (SEND-06): each insert is `onConflictDoNothing` against
 *    the existing UNIQUE(campaign_id, to_addr), so a re-claimed campaign inserts
 *    only the rows it is missing — never a duplicate. A second materialize of the
 *    same campaign inserts zero rows.
 *  - Duplicate-address collapse (Pitfall 2 / decision A3): two CSV rows with the
 *    same address collapse to ONE send_record. `campaigns.total` is therefore
 *    reconciled to the actual send_records count — NOT the raw CSV row count — so
 *    the "remaining = total - sent - failed" math can still reach zero.
 *
 * TENANCY (worker exception, PITFALLS #13): the worker has no Clerk session, so it
 * derives the owner from `campaign.userId` and resolves the campaign's OWN FKs
 * through the userId-scoped DAL — never a client-supplied value.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { send_records, campaigns, type Campaign } from "@/lib/db/schema";
import {
  getRecipientSetForUser,
  getTemplateForUser,
  listAttachmentsForCampaign,
} from "@/lib/data";
import { readUpload } from "@/lib/csv";
import {
  parseCsv,
  detectEmailColumn,
  resolveAttachmentColumn,
  fillMessage,
  isValidEmail,
} from "@/lib/core";

/** The error stamped on a row whose address failed the shared validity gate. */
const INVALID_ADDRESS_ERROR = "rejected: invalid address";

/**
 * Materialize one `pending` send_record per unique CSV recipient for a claimed
 * campaign. Returns how many NEW rows were inserted this call (0 on a resume) and
 * the reconciled `total` (== the current send_records count for the campaign).
 *
 * @param campaign The claimed campaign row (its userId + FKs drive resolution).
 */
export async function materializeSendRecords(
  campaign: Campaign,
): Promise<{ inserted: number; total: number }> {
  // Resolve the campaign's OWN recipient set + template, owner-scoped from
  // campaign.userId (worker tenancy exception) — never a client value.
  const set = await getRecipientSetForUser(campaign.userId, campaign.recipient_set_id);
  if (!set) throw new Error(`recipient set ${campaign.recipient_set_id} not found for campaign ${campaign.id}`);
  const template = await getTemplateForUser(campaign.userId, campaign.template_id);
  if (!template) throw new Error(`template ${campaign.template_id} not found for campaign ${campaign.id}`);

  // Read + parse the stored CSV server-side (readUpload also enforces the
  // traversal boundary). parseCsv/detectEmailColumn are the tested lib/core
  // primitives — no hand-rolled splitting here.
  const { columns, rows } = parseCsv(readUpload(set.storage_path));

  // The user-confirmed column WINS; fall back to detection only if unset. Without
  // a resolvable email column there is nothing to address — fail loudly.
  const emailColumn = set.email_column ?? detectEmailColumn(columns, rows);
  if (!emailColumn) {
    throw new Error(`no email column resolvable for campaign ${campaign.id}`);
  }

  let inserted = 0;
  let invalidInserted = 0;
  for (const row of rows) {
    // Validate the address with the SAME predicate the confirm gate uses (WR-05).
    const addr = (row[emailColumn] ?? "").trim();

    // A blank/missing cell is UNADDRESSABLE: skip it entirely. This mirrors the
    // confirm gate excluding blanks, avoids the NOT NULL violation that poisoned
    // the queue (CR-02), and prevents every blank row collapsing into one "" record.
    if (!addr) continue;

    // fillMessage personalizes BOTH subject and body (EDIT-03) — reused verbatim.
    const merged = fillMessage(
      { subject: template.subject, body: template.body },
      row,
    );

    // A malformed (non-blank) address is materialized as a TERMINAL failed record
    // immediately, rather than silently attempted against SMTP. The user gets a
    // visible per-row record ("rejected: invalid address") and `total` stays
    // consistent with the drill-down table.
    const valid = isValidEmail(addr);

    // onConflictDoNothing against UNIQUE(campaign_id,to_addr): a duplicate address
    // (in this CSV) or a resumed campaign (row already present) is a silent no-op.
    // `.returning()` yields the inserted row ONLY when an insert actually happened,
    // so its length is the "did I insert?" signal.
    const created = await db
      .insert(send_records)
      .values({
        campaign_id: campaign.id,
        to_addr: addr,
        merged_subject: merged.subject,
        merged_body: merged.body,
        ...(valid
          ? {}
          : { status: "failed", error: INVALID_ADDRESS_ERROR }),
      })
      .onConflictDoNothing()
      .returning({ id: send_records.id });
    if (created.length > 0) {
      inserted++;
      if (!valid) invalidInserted++;
    }
  }

  // Link each row to its attachment by stamping the INVERTED FK on the send_record
  // (send_records.attachment_id), NOT on the attachment. Because the FK lives on
  // send_records, MANY rows can point at the SAME attachment — a file referenced by
  // many CSV rows links EVERY referencing row (BLOCKER-2 fix), where a per-attachment
  // send_record_id would have carried it on only the last row. Column resolution is
  // the SINGLE shared `resolveAttachmentColumn` helper (WR-03) — a confirmed column
  // wins, else auto-detect that never co-opts the email column.
  const attachmentColumn = resolveAttachmentColumn(set, columns, rows);
  if (attachmentColumn) {
    const campaignAttachments = await listAttachmentsForCampaign(
      campaign.userId,
      campaign.id,
    );
    if (campaignAttachments.length > 0) {
      // Match on the ORIGINAL filename, trimmed + case-insensitive (same key the
      // shared computeAttachmentMatch uses — zero divergence).
      const byName = new Map(
        campaignAttachments.map((a) => [a.filename.trim().toLowerCase(), a.id]),
      );
      for (const row of rows) {
        const addr = (row[emailColumn] ?? "").trim();
        if (!addr) continue; // blank address was never materialized
        const cell = (row[attachmentColumn] ?? "").trim();
        if (!cell) continue; // empty cell → attachment_id stays null (no attachment)
        const matchedId = byName.get(cell.toLowerCase());
        if (matchedId === undefined) continue; // no matching upload → row un-linked
        // Stamp the send_record for this address (the UNIQUE(campaign_id,to_addr)
        // row). Every distinct address referencing a shared file is stamped here.
        await db
          .update(send_records)
          .set({ attachment_id: matchedId })
          .where(
            and(
              eq(send_records.campaign_id, campaign.id),
              eq(send_records.to_addr, addr),
            ),
          );
      }
    }
  }

  // Reconcile the counter to the MATERIALIZED count (dedup-honest) so progress
  // math converges even when addresses collapsed. When we materialized invalid
  // addresses as failed rows, bump failed_count by that many so
  // remaining = total - sent - failed stays honest. Both writes are one
  // synchronous transaction (WR-04-consistent) so the counters never tear.
  db.transaction((tx) => {
    tx.update(campaigns)
      .set({
        total: sql`(SELECT count(*) FROM ${send_records} WHERE ${send_records.campaign_id} = ${campaign.id})`,
      })
      .where(eq(campaigns.id, campaign.id))
      .run();
    if (invalidInserted > 0) {
      tx.update(campaigns)
        .set({ failed_count: sql`${campaigns.failed_count} + ${invalidInserted}` })
        .where(eq(campaigns.id, campaign.id))
        .run();
    }
  });

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(send_records)
    .where(eq(send_records.campaign_id, campaign.id));

  return { inserted, total };
}
