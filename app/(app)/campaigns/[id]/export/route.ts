/**
 * GET /campaigns/[id]/export — download a per-recipient results CSV (HIST-03).
 *
 * The first GET route handler in the repo. Unlike the Server-Action seam (which
 * uses the lazy `auth()` import in actions.ts), a route handler runs ONLY under
 * the Next server runtime, so we import `auth` DIRECTLY from
 * `@clerk/nextjs/server`.
 *
 * IDOR defense (T-06-17): the campaign id arrives in the URL, so we re-derive the
 * Clerk userId server-side and read the campaign ONLY through
 * `getCampaignForUser(userId, id)`. A guessed / cross-tenant id returns undefined
 * → 404, and `Number(id)` producing NaN also fails the owner match → 404. The
 * send_records are read solely via `getSendRecordsForCampaign(userId, ...)` — the
 * ownership-gated DAL — never a raw by-id query. The CSV body is produced by the
 * formula-injection-safe `toResultsCsv` (T-06-18).
 */

import { auth } from "@clerk/nextjs/server";

import { getCampaignForUser, getSendRecordsForCampaign } from "@/lib/data";
import { toResultsCsv } from "@/lib/campaign/results-csv";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Re-derive the tenant server-side — the URL id is untrusted.
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;

  // Owner-scoped read: a cross-tenant / bogus / NaN id → undefined → 404.
  const campaign = await getCampaignForUser(userId, Number(id));
  if (!campaign) return new Response("Not found", { status: 404 });

  // send_records read only through the ownership-gated DAL (never a raw by-id query).
  const rows = await getSendRecordsForCampaign(userId, campaign.id);
  const csv = toResultsCsv(rows);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="campaign-${campaign.id}-results.csv"`,
    },
  });
}
