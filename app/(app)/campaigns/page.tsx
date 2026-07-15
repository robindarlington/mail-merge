import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { Inbox } from "lucide-react";

import { listCampaignsForUser, listTemplatesForUser } from "@/lib/data";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CampaignStatusBadge } from "@/components/campaign/campaign-status-badge";

/**
 * /campaigns — the campaign history list (HIST-01). An async RSC that re-derives
 * the Clerk `userId` server-side and lists ONLY that user's campaigns via the
 * userId-scoped DAL (`listCampaignsForUser`, newest first). An unauthenticated
 * load yields an empty list, never another tenant's campaigns (T-06-14 / AUTH-02).
 *
 * The row title is the campaign's template subject (falling back to "Campaign
 * #{id}"). Rather than fetch a template per row (N+1), we load the user's
 * templates once and map by id. Every row links to /campaigns/[id] as a neutral
 * clickable row — no per-row accent (06-UI-SPEC one-accent discipline); the single
 * accent on an empty list is the "Go to compose" CTA.
 */

/** Human-friendly relative date from a unixepoch-seconds timestamp (RSC-only, static). */
function formatRelativeDate(unixSeconds: number): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diffSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === "second") {
      return rtf.format(Math.round(diffSeconds / secs), unit);
    }
  }
  return "just now";
}

export default async function CampaignsPage() {
  const { userId } = await auth();
  const [campaigns, templates] = userId
    ? await Promise.all([
        listCampaignsForUser(userId),
        listTemplatesForUser(userId),
      ])
    : [[], []];

  const subjectById = new Map(templates.map((t) => [t.id, t.subject]));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold leading-[1.2]">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Every send you&apos;ve started, newest first.
        </p>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <Inbox className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold leading-[1.2]">
              No campaigns yet
            </h2>
            <p className="text-sm text-muted-foreground">
              Your sends will appear here once you start one. Upload a CSV, compose
              your email, then review and send.
            </p>
          </div>
          <Button asChild>
            <Link href="/compose">Go to compose</Link>
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((campaign) => {
              const title =
                subjectById.get(campaign.template_id) ??
                `Campaign #${campaign.id}`;
              return (
                <TableRow
                  key={campaign.id}
                  className="relative cursor-pointer hover:bg-muted"
                >
                  <TableCell>
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="font-medium after:absolute after:inset-0 after:content-['']"
                    >
                      {title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {campaign.total} recipients
                  </TableCell>
                  <TableCell>
                    <CampaignStatusBadge status={campaign.status} />
                  </TableCell>
                  <TableCell>
                    {campaign.sent_count} / {campaign.total} sent
                    {campaign.failed_count > 0 ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {campaign.failed_count} failed
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelativeDate(campaign.created_at)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
