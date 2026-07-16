import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Download } from "lucide-react";

import {
  getCampaignForUser,
  getSendRecordsForCampaign,
  getSmtpConfigByIdForUser,
  getTemplateForUser,
  listAttachmentsForCampaign,
  toSmtpConfigDto,
} from "@/lib/data";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CampaignStatusBadge } from "@/components/campaign/campaign-status-badge";
import { CampaignSummaryLine } from "@/components/campaign/campaign-summary-line";
import { DeleteCampaignButton } from "@/components/campaign/delete-campaign-button";
import { ProgressPanel } from "@/components/campaign/progress-panel";
import { RecipientResultsTable } from "@/components/campaign/recipient-results-table";

/**
 * /campaigns/[id] — the campaign detail / drill-down (HIST-02 + SEND-05 host). An
 * async RSC (Next 16 async params) that re-derives the Clerk `userId` and reads
 * ONLY through userId-scoped DAL functions. An unknown or cross-tenant id resolves
 * to `undefined` and renders the framework not-found — never another tenant's data
 * (T-06-14 / AUTH-02). Number(id) on a non-numeric slug yields NaN → notFound too.
 *
 * The meta line's sender address comes from the REDACTED SMTP DTO (toSmtpConfigDto),
 * which structurally omits the password triple (T-06-16) — the raw config row never
 * reaches the client.
 *
 * While the campaign is queued/running the live ProgressPanel (a client poller) is
 * shown; once terminal the RSC renders a static summary (completed) or a destructive
 * abort Alert (whole-campaign failed). The results table is always rendered below.
 */

function formatStartedAt(unixSeconds: number | null): string {
  if (!unixSeconds) return "not started yet";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { userId } = await auth();
  const campaign = userId
    ? await getCampaignForUser(userId, Number(id))
    : undefined;
  if (!userId || !campaign) notFound();

  const [records, template, configRow, campaignAttachments] = await Promise.all([
    getSendRecordsForCampaign(userId, campaign.id),
    getTemplateForUser(userId, campaign.template_id),
    getSmtpConfigByIdForUser(userId, campaign.smtp_config_id),
    listAttachmentsForCampaign(userId, campaign.id),
  ]);

  // Resolve each send_record's inverted attachment_id → original filename (a file
  // shared by many rows links every one). Owner-scoped read; display-only.
  const attachmentById = new Map(
    campaignAttachments.map((a) => [a.id, a.filename] as const),
  );
  const attachmentNames = new Map<number, string>();
  for (const record of records) {
    if (record.attachment_id != null) {
      const filename = attachmentById.get(record.attachment_id);
      if (filename) attachmentNames.set(record.id, filename);
    }
  }

  const title = template?.subject ?? `Campaign #${campaign.id}`;
  const smtp = configRow ? toSmtpConfigDto(configRow) : null;
  const isActive = campaign.status === "queued" || campaign.status === "running";
  const canDownload =
    campaign.status === "completed" || campaign.status === "failed";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/campaigns">
            <ChevronLeft />
            Back to campaigns
          </Link>
        </Button>
        <DeleteCampaignButton campaignId={campaign.id} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold leading-[1.2]">{title}</h1>
          <CampaignStatusBadge status={campaign.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Started {formatStartedAt(campaign.started_at ?? campaign.created_at)} ·{" "}
          {campaign.total} recipients
          {smtp ? <> · Sending over {smtp.from_addr}</> : null}
        </p>
      </div>

      <Separator />

      {isActive ? (
        <ProgressPanel
          campaignId={campaign.id}
          initialStatus={campaign.status}
          initialProgress={{
            status: campaign.status,
            total: campaign.total,
            sent: campaign.sent_count,
            failed: campaign.failed_count,
            remaining:
              campaign.total - campaign.sent_count - campaign.failed_count,
            current: null,
          }}
        />
      ) : campaign.status === "failed" ? (
        <Alert variant="destructive">
          <AlertTitle>
            {campaign.sent_count > 0
              ? "This send stopped partway through"
              : "This send couldn't start"}
          </AlertTitle>
          <AlertDescription>
            {campaign.sent_count > 0
              ? `The send stopped after ${campaign.sent_count} of ${campaign.total} messages — your SMTP server stopped accepting the connection, or the settings were no longer valid. Delivered messages are listed below; nothing was sent twice. Check your SMTP settings and start a new send for the rest.`
              : "No emails were sent. Either the recipient list's stored file was missing, or your SMTP server didn't accept the connection. Check the list still opens under Lists and your SMTP settings, then start a new send."}
          </AlertDescription>
        </Alert>
      ) : (
        <CampaignSummaryLine
          status={campaign.status}
          total={campaign.total}
          sent={campaign.sent_count}
          failed={campaign.failed_count}
        />
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold leading-[1.2]">
          Per-recipient results
        </h2>
        {canDownload ? (
          <Button asChild>
            <Link href={`/campaigns/${campaign.id}/export`}>
              <Download />
              Download results
            </Link>
          </Button>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button disabled>
                    <Download />
                    Download results
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>Available once the send finishes.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <RecipientResultsTable
        records={records}
        attachmentNames={attachmentNames}
        campaignStatus={campaign.status}
      />
    </div>
  );
}
