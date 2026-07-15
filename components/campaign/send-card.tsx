"use client";

import { useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";

import type { SmtpConfigDto } from "@/lib/data";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TestSendPanel } from "@/components/campaign/test-send-panel";
import { ConfirmSendDialog } from "@/components/campaign/confirm-send-dialog";

/**
 * SendCard — the gated "Send" section on /compose (05-UI-SPEC U1, extended by
 * 06.1-UI-SPEC for multi-server). It wires the whole-batch test-send panel and the
 * undismissable confirm gate to the currently selected recipient list, the
 * most-recently saved standalone template, AND the chosen verified SMTP server.
 *
 * Ordering (06.1 walkthrough fix): the server block (no-servers gate / single-server
 * static line / multi-server "Send with" picker) ALWAYS renders FIRST, independent
 * of the template — the picker must be visible whenever multiple verified servers
 * exist, not hidden behind a session template save. When no template is saved yet,
 * a "Save your template above first." muted line renders BELOW it as the gate
 * explaining why the send controls (test-send + Review and send) aren't available.
 *
 * Server picker (06.1, CONTEXT.md LOCKED):
 *   - zero verified servers → the disabled add-and-verify gate;
 *   - exactly one verified server → a zero-click static "Sending over …" line (no
 *     dropdown), its id auto-selected upstream;
 *   - multiple → a shadcn `Select` labeled "Send with", pre-selecting the account
 *     default, or a "Choose a server" placeholder in the no-default state (send
 *     actions stay gated until one is chosen — NO auto-promote).
 *
 * The client only PROPOSES a `smtpConfigId`; the server owner-re-resolves it. The
 * picker is built from the redacted DTO only — the encrypted triple never crosses
 * the boundary. "Review and send" is the ONE accent button here; the picker is a
 * neutral control (focus ring only accent).
 */

/** The picker's display name for a server: its label, falling back to the sender
 *  address when a row has no label (defensive — the backfill stamps 'Default'). */
function displayLabel(config: SmtpConfigDto): string {
  return config.label ?? config.from_addr;
}

export function SendCard({
  recipientSetId,
  templateId,
  recipientCount,
  configs,
  smtpConfigId,
  onSelect,
  defaultTestEmail,
}: {
  recipientSetId: string;
  templateId: number | null;
  recipientCount: number;
  configs: SmtpConfigDto[];
  smtpConfigId: number | null;
  onSelect: (id: number) => void;
  defaultTestEmail: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const noServers = configs.length === 0;
  const singleServer = configs.length === 1;
  const soleServer = singleServer ? configs[0] : null;
  // Multiple verified servers exist but the user hasn't chosen one yet (no-default
  // state) — send actions stay gated until a choice stands.
  const noneChosen = configs.length > 1 && smtpConfigId === null;
  const ready = templateId !== null && smtpConfigId !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Send</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {noServers ? (
          <p className="text-sm text-muted-foreground">
            Add and verify at least one SMTP server in{" "}
            <Link href="/settings/smtp" className="underline underline-offset-2">
              settings
            </Link>{" "}
            before you can send.
          </p>
        ) : singleServer && soleServer ? (
          <p className="text-sm text-muted-foreground">
            {`Sending over ${displayLabel(soleServer)} (${soleServer.from_addr})`}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="send-with">Send with</Label>
            <Select
              value={smtpConfigId !== null ? String(smtpConfigId) : ""}
              onValueChange={(value) => onSelect(Number(value))}
            >
              <SelectTrigger id="send-with" className="w-full">
                <SelectValue placeholder="Choose a server" />
              </SelectTrigger>
              <SelectContent>
                {configs.map((config) => (
                  <SelectItem key={config.id} value={String(config.id)}>
                    {`${displayLabel(config)} — ${config.from_addr}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {templateId === null ? (
          <p className="text-sm text-muted-foreground">
            Save your template above first.
          </p>
        ) : null}

        {templateId !== null && smtpConfigId !== null ? (
          <TestSendPanel
            recipientSetId={recipientSetId}
            templateId={templateId}
            smtpConfigId={smtpConfigId}
            recipientCount={recipientCount}
            defaultTestEmail={defaultTestEmail}
          />
        ) : null}

        {noneChosen ? (
          <p className="text-sm text-muted-foreground">
            Choose which server to send with above.
          </p>
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

        {templateId !== null && smtpConfigId !== null ? (
          <ConfirmSendDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            recipientSetId={recipientSetId}
            templateId={templateId}
            smtpConfigId={smtpConfigId}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
