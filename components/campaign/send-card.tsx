"use client";

import { useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TestSendPanel } from "@/components/campaign/test-send-panel";
import { ConfirmSendDialog } from "@/components/campaign/confirm-send-dialog";

/**
 * SendCard — the gated "Send" section on /compose (05-UI-SPEC U1). It wires the
 * whole-batch test-send panel and the undismissable confirm gate to the currently
 * selected recipient list + the most-recently saved standalone template.
 *
 * Gating: both actions need a saved template AND a configured SMTP server. When
 * either is missing the card shows the exact disabled-state help copy and keeps
 * the actions disabled. "Review and send" is the ONE accent button in this card;
 * the test-send button is `outline`/`secondary` (one-accent-per-view rule).
 */
export function SendCard({
  recipientSetId,
  templateId,
  recipientCount,
  hasSmtpConfig,
  defaultTestEmail,
}: {
  recipientSetId: string;
  templateId: number | null;
  recipientCount: number;
  hasSmtpConfig: boolean;
  defaultTestEmail: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ready = templateId !== null && hasSmtpConfig;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Send</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {templateId === null ? (
          <p className="text-sm text-muted-foreground">
            Save your template above first.
          </p>
        ) : !hasSmtpConfig ? (
          <p className="text-sm text-muted-foreground">
            Add and verify an SMTP server in{" "}
            <Link href="/settings/smtp" className="underline underline-offset-2">
              settings
            </Link>{" "}
            before you can send.
          </p>
        ) : null}

        {templateId !== null ? (
          <TestSendPanel
            recipientSetId={recipientSetId}
            templateId={templateId}
            recipientCount={recipientCount}
            defaultTestEmail={defaultTestEmail}
            disabled={!hasSmtpConfig}
          />
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!ready}
            onClick={() => setConfirmOpen(true)}
          >
            <Send />
            Review and send
          </Button>
        </div>

        {templateId !== null && hasSmtpConfig ? (
          <ConfirmSendDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            recipientSetId={recipientSetId}
            templateId={templateId}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
