"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Send,
} from "lucide-react";

import { sendTestBatchChunk, type ActionError } from "@/lib/campaign/actions";
import { TEST_SEND_DELAY_MS, testAddressSchema } from "@/lib/campaign/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * TestSendPanel (TEST-01) — the whole-batch test-send safety surface on /compose.
 *
 * It mirrors `components/smtp/step-test-send.tsx` verbatim in voice and structure
 * (address Input → Send/Loader2 CTA → typed-failure destructive Alert → Collapsible
 * technical details), but drives the WHOLE personalized batch to one address by
 * looping the chunked Server Action (`sendTestBatchChunk`) client-side over the
 * `{nextOffset, done, total}` cursor until `done`. There is NO row limit — only a
 * soft duration warning for large sets (05-UI-SPEC Assumption U2). The action
 * (Plans 02/03) keeps the decrypted SMTP password server-side; this client only
 * ever passes ids + the test address, and never renders a cell value as HTML.
 */

type Failure = { reason: string; raw?: string };

type Progress = { sent: number; failed: number; done: number; total: number };

type Summary = { sent: number; failed: number; errors: string[]; total: number };

/**
 * Map a campaign ActionError to a short human reason + optional raw message
 * detail. Extends the `step-test-send.tsx` `failureFor` for the campaign union
 * (a `raw` is always a message STRING — never a raw Error, D-06).
 */
function failureFor(error: ActionError): Failure {
  switch (error.kind) {
    case "unauthenticated":
      return { reason: "your session has expired" };
    case "validation":
      return { reason: "the test address is invalid" };
    case "not_found":
      return { reason: "that recipient list or template is no longer available" };
    case "no_smtp_config":
      return {
        reason: "you haven't added an SMTP server yet — add one in settings",
      };
    case "parse_error":
      return { reason: "we couldn't read that CSV" };
    case "send_failed":
      return { reason: "the server rejected the messages", raw: error.raw };
    case "unknown":
      return { reason: "an unexpected error occurred", raw: error.raw };
    default:
      return { reason: "an unexpected error occurred" };
  }
}

/** Rough human duration for the soft note: ~0.5s pacing per message. */
function estimateDuration(count: number): string {
  const seconds = Math.round(count * (TEST_SEND_DELAY_MS / 1000));
  if (seconds < 60) return `${Math.max(seconds, 1)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function TestSendPanel({
  recipientSetId,
  templateId,
  smtpConfigId,
  recipientCount,
  defaultTestEmail,
  disabled = false,
}: {
  recipientSetId: string;
  templateId: number;
  smtpConfigId: number;
  recipientCount: number;
  defaultTestEmail: string;
  disabled?: boolean;
}) {
  const [to, setTo] = useState(defaultTestEmail);
  const [sending, setSending] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const address = to.trim();
  const addressValid = testAddressSchema.safeParse(address).success;
  const duration = useMemo(
    () => estimateDuration(recipientCount),
    [recipientCount],
  );
  // A soft, non-blocking prominence threshold (Assumption U2 — no row limit).
  const isLargeSet = recipientCount > 50;

  async function send() {
    if (!addressValid) {
      setAddressError("Enter a valid test address.");
      return;
    }
    setAddressError(null);
    setSending(true);
    setFailure(null);
    setSummary(null);
    setProgress(null);

    let offset = 0;
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    while (true) {
      const res = await sendTestBatchChunk({
        recipientSetId,
        templateId,
        smtpConfigId,
        testAddress: address,
        offset,
      });
      if (!res.ok) {
        // A failure on the very first chunk (e.g. verify failed) is a total
        // failure — nothing was sent. A later-chunk failure keeps the partial
        // progress already accumulated but still surfaces the reason.
        setFailure(failureFor(res.error));
        break;
      }
      sent += res.data.sent;
      failed += res.data.failed;
      errors.push(...res.data.errors);
      setProgress({
        sent,
        failed,
        done: res.data.nextOffset,
        total: res.data.total,
      });
      if (res.data.done) {
        setSummary({ sent, failed, errors, total: res.data.total });
        toast.success(`Sent ${sent} test messages to ${address}.`);
        break;
      }
      offset = res.data.nextOffset;
    }
    setSending(false);
  }

  const reasonSentence = failure
    ? failure.reason.charAt(0).toUpperCase() + failure.reason.slice(1)
    : "";
  const controlsDisabled = disabled || sending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-xl font-semibold leading-[1.2]">Send a test batch</h3>
        <p className="text-sm text-muted-foreground">
          Send every recipient&apos;s personalized email to one address, so you can
          check the whole batch before it goes live.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="test-address">Test address</Label>
        <Input
          id="test-address"
          type="email"
          value={to}
          disabled={controlsDisabled}
          onChange={(e) => {
            setTo(e.target.value);
            if (addressError) setAddressError(null);
          }}
        />
        {addressError ? (
          <p className="text-sm text-destructive">{addressError}</p>
        ) : null}
      </div>

      {isLargeSet ? (
        <div className="flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {`Sending all ${recipientCount} messages will take roughly ${duration}. Keep this tab open — closing it stops the test partway.`}
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {`This sends ${recipientCount} messages to ${address || "your test address"}, about ${duration}. Keep this tab open until it finishes.`}
          </span>
        </div>
      )}

      {sending && progress ? (
        <p className="text-sm text-muted-foreground">
          {`Sent ${progress.done} of ${progress.total}…`}
        </p>
      ) : null}

      {summary ? (
        summary.failed === 0 ? (
          <div className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{`Sent all ${summary.sent} messages to ${address}.`}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {`Sent ${summary.sent} of ${summary.total}. ${summary.failed} couldn't be delivered — see the reasons below.`}
            </p>
            <ul className="flex flex-col gap-1">
              {summary.errors.map((line, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm text-muted-foreground"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {failure ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Test batch failed to send</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              {`None of the test messages could be sent. ${reasonSentence}. Your template and settings are unchanged.`}
            </span>
            {failure.raw ? (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm">
                    <ChevronDown />
                    Show technical details
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-2.5 text-sm text-muted-foreground">
                    {failure.raw}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-start">
        <Button
          type="button"
          variant="outline"
          disabled={controlsDisabled || !addressValid}
          onClick={send}
        >
          {sending ? (
            <>
              <Loader2 className="animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Send />
              Send test batch
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
