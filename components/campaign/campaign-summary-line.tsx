import { AlertCircle, CheckCircle2 } from "lucide-react";

/**
 * CampaignSummaryLine — the single source of truth for a COMPLETED campaign's
 * terminal summary copy (06-UI-SPEC Copywriting Contract). Shared by the live
 * ProgressPanel (which reaches terminal while polling) and the detail-page RSC
 * (which loads an already-terminal campaign), so the wording can never drift.
 *
 * Three `completed` variants, per the contract:
 *   all sent (failed=0)      → success-toned  "Done — all {total} messages sent."
 *   partial (sent>0,failed>0)→ success-toned  "Done — {sent} sent, {failed} failed…"
 *   all failed (sent=0)      → muted          "…none of the {total} messages were delivered…"
 *
 * A whole-campaign abort (`status === "failed"`) is NOT handled here — that is a
 * destructive Alert with the abort reason, rendered by the detail page. This
 * component returns null for any non-`completed` status.
 */
export function CampaignSummaryLine({
  status,
  total,
  sent,
  failed,
}: {
  status: string;
  total: number;
  sent: number;
  failed: number;
}) {
  if (status !== "completed") return null;

  if (failed === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-success">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>{`Done — all ${total} messages sent.`}</span>
      </div>
    );
  }

  if (sent === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>
          {`This send finished, but none of the ${total} messages were delivered. Check the reasons below.`}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-sm">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      <span>
        {`Done — ${sent} sent, `}
        <span className="text-muted-foreground">{`${failed} failed`}</span>
        {`. See the per-recipient results below.`}
      </span>
    </div>
  );
}
