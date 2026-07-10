"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Send } from "lucide-react";

import { sendTestEmail, type ActionError } from "@/lib/smtp/actions";
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
 * Step 3 of the wizard — the SKIPPABLE test-send (D-03 / SMTP-05). By the time
 * we're here the config is already saved and verified, so this step only proves
 * real delivery; "Skip for now" completes onboarding without sending.
 *
 * "Send test email" calls `sendTestEmail(toAddress)`; the server decrypts the
 * password, runs verify-before-send, and sends one real message. Success shows a
 * toast and completes onboarding; a failure keeps the (already-saved) settings
 * and surfaces a classified reason plus a message-only technical detail
 * (T-2-CRED — never the password).
 */

type Failure = { reason: string; raw?: string };

/** Map an action failure to a short human reason + optional raw detail. */
function failureFor(error: ActionError): Failure {
  switch (error.kind) {
    case "unauthenticated":
      return { reason: "your session has expired" };
    case "rate_limited":
      return { reason: "too many attempts were made" };
    case "validation":
      return { reason: "the recipient address is invalid" };
    case "send_failed":
      return { reason: "the server rejected the message", raw: error.raw };
    default: {
      const map: Record<"auth" | "connection" | "tls" | "unknown", string> = {
        auth: "the server rejected your credentials",
        connection: "the server couldn't be reached",
        tls: "the secure connection failed",
        unknown: "an unexpected error occurred",
      };
      return { reason: map[error.kind], raw: error.raw };
    }
  }
}

export function StepTestSend({
  defaultEmail,
  onComplete,
}: {
  defaultEmail: string;
  onComplete: () => void;
}) {
  const [to, setTo] = useState(defaultEmail);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function send() {
    const recipient = to.trim();
    setSending(true);
    setFailure(null);
    const res = await sendTestEmail(recipient || undefined);
    setSending(false);
    if (res.ok) {
      toast.success(`Test email sent — check ${recipient}'s inbox.`);
      onComplete();
      return;
    }
    setFailure(failureFor(res.error));
  }

  const reasonSentence = failure
    ? failure.reason.charAt(0).toUpperCase() + failure.reason.slice(1)
    : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-success">
        <CheckCircle2 className="size-4" />
        <span className="text-sm">Connection verified</span>
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold leading-[1.2]">Send a test email</h2>
        <p className="text-sm text-muted-foreground">
          Send yourself a test to confirm delivery. Your connection is already
          verified, so this step is optional.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="test-recipient">Recipient</Label>
        <Input
          id="test-recipient"
          type="email"
          value={to}
          disabled={sending}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      {failure ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Test email failed to send</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              {reasonSentence}. Your settings are still saved and verified.
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

      <div className="flex items-center justify-between gap-4">
        <Button type="button" variant="ghost" disabled={sending} onClick={onComplete}>
          Skip for now
        </Button>
        <Button type="button" disabled={sending} onClick={send}>
          {sending ? (
            <>
              <Loader2 className="animate-spin" />
              Sending…
            </>
          ) : (
            <>
              <Send />
              Send test email
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
