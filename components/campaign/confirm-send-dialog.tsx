"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";

import {
  prepareCampaign,
  buildConfirmSummary,
  enqueueCampaign,
  type ConfirmSummary,
} from "@/lib/campaign/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * ConfirmSendDialog (TEST-02/TEST-03) — the undismissable live-send confirmation
 * gate. This modal DISPLAYS the server-authoritative review (`buildConfirmSummary`)
 * and enqueues exactly once (`enqueueCampaign`); it computes NO counts itself
 * (T-5-TAMPER). The merged sample renders as escaped JSX text via
 * `whitespace-pre-wrap` — a CSV cell can never be injected as raw HTML (T-5-XSS).
 * The gate closes ONLY via Cancel or a
 * successful enqueue (05-UI-SPEC Interaction rules): `showCloseButton={false}` plus
 * `preventDefault` on interact-outside / escape.
 *
 * On EVERY open transition (and whenever [recipientSetId, templateId] change) the
 * prior campaignId/summary are reset, then a fresh draft is prepared and its
 * summary fetched — so a review NEVER shows a summary built from a previously
 * selected list/template (stale-summary guard).
 */

/** Render unknown tokens as literal `{{token}}` for the authoring warning copy. */
function formatTokens(tokens: string[]): string {
  return tokens.map((t) => `{{${t}}}`).join(", ");
}

export function ConfirmSendDialog({
  recipientSetId,
  templateId,
  open,
  onOpenChange,
}: {
  recipientSetId: string;
  templateId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [summary, setSummary] = useState<ConfirmSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  // Stale-summary guard (checker fix): a change of the selected list/template
  // ALWAYS drops any prior campaignId/summary, even while the modal is closed, so
  // a later review can never render a summary built from an earlier selection.
  useEffect(() => {
    setCampaignId(null);
    setSummary(null);
  }, [recipientSetId, templateId]);

  // On every open transition (and on a selection change while open), reset prior
  // state then prepare the draft + fetch its server-authoritative summary.
  useEffect(() => {
    if (!open) return;
    let ignore = false;
    setCampaignId(null);
    setSummary(null);
    setLoadFailed(false);
    setEnqueueError(null);
    setLoading(true);
    (async () => {
      const prep = await prepareCampaign({ recipientSetId, templateId });
      if (ignore) return;
      if (!prep.ok) {
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      const sum = await buildConfirmSummary({ campaignId: prep.data.campaignId });
      if (ignore) return;
      if (!sum.ok) {
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      setCampaignId(prep.data.campaignId);
      setSummary(sum.data);
      setLoading(false);
    })();
    return () => {
      ignore = true;
    };
  }, [open, recipientSetId, templateId]);

  async function confirm() {
    if (campaignId === null) return;
    setSubmitting(true);
    setEnqueueError(null);
    const res = await enqueueCampaign({ campaignId });
    setSubmitting(false);
    if (res.ok) {
      toast.success(`Your send is queued — ${summary?.sendableCount ?? 0} recipients.`);
      onOpenChange(false);
      return;
    }
    if (res.error.kind === "already_queued") {
      // Benign second-caller path (the DB atomic guard) — never a destructive error.
      toast("This send is already queued.");
      onOpenChange(false);
      return;
    }
    if (res.error.kind === "unauthenticated") {
      setEnqueueError("Your session has expired. Sign in again to send.");
      return;
    }
    setEnqueueError(
      "We couldn't queue your send. Try again, and if it keeps failing, refresh the page.",
    );
  }

  const noneSendable = summary !== null && summary.sendableCount === 0;
  const confirmDisabled = loading || !summary || noneSendable || submitting;
  const n = summary?.recipientCount ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Send to everyone?</DialogTitle>
          <DialogDescription>
            Review the details below. This sends real email over your SMTP and
            can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-5 w-48" />
          </div>
        ) : loadFailed ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn&apos;t load the send details</AlertTitle>
            <AlertDescription>
              We couldn&apos;t load the send details. Try again, and if it keeps
              failing, refresh the page.
            </AlertDescription>
          </Alert>
        ) : summary ? (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            <div className="flex flex-col gap-1 text-sm">
              <p>
                {`Recipients: ${summary.recipientCount}`}
                {summary.invalidEmailCount > 0 ? (
                  <span className="text-muted-foreground">
                    {` — ${summary.invalidEmailCount} skipped — invalid email`}
                  </span>
                ) : null}
              </p>
              <p>{`From: ${summary.senderIdentity}`}</p>
            </div>

            <Separator />

            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold">Sample — how row 1 will look</p>
              <p className="text-sm text-muted-foreground">{`To: ${summary.sample.to}`}</p>
              <p className="text-sm text-muted-foreground">
                {`Subject: ${summary.sample.subject}`}
              </p>
              <div className="mt-1 max-h-48 overflow-y-auto rounded-lg bg-muted p-3">
                <p className="text-base whitespace-pre-wrap">{summary.sample.body}</p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2 text-sm">
              {summary.unknownTokens.length > 0 ? (
                <div className="flex items-start gap-2 text-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {`Your template uses ${formatTokens(summary.unknownTokens)}, which ${
                      summary.unknownTokens.length === 1 ? "isn't" : "aren't"
                    } a column in this list. It will appear literally in every email — cancel and fix it, or send anyway.`}
                  </span>
                </div>
              ) : null}

              {noneSendable ? (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    No rows have a valid email address, so there&apos;s nothing to
                    send. Cancel and check your recipient list.
                  </span>
                </div>
              ) : summary.invalidEmailCount > 0 ? (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {`${summary.invalidEmailCount} of ${n} rows don't have a valid email address. They'll be skipped.`}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-success">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  <span>{`All ${n} rows have a valid email address.`}</span>
                </div>
              )}

              {summary.rowsWithGaps > 0 ? (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {`${summary.rowsWithGaps} of ${n} rows are missing a value for at least one merge field. Those spots will be blank.`}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-success">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  <span>Every row has a value for each merge field.</span>
                </div>
              )}
            </div>

            {enqueueError ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Couldn&apos;t queue your send</AlertTitle>
                <AlertDescription>{enqueueError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" disabled={confirmDisabled} onClick={confirm}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                Queuing…
              </>
            ) : (
              <>
                <Send />
                {`Send to ${summary?.sendableCount ?? 0} recipients`}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
