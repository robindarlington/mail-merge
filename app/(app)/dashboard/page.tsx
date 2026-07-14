import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { CheckCircle2 } from "lucide-react";

import { listSmtpConfigsForUser, toSmtpConfigDto } from "@/lib/data/smtp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Dashboard — a signed-in user's home and, for a fresh account, the dominant
 * next action (D-02 soft gate). As of 06.1 readiness is a MULTI-server rule: the
 * account is ready to send once it has AT LEAST ONE verified SMTP server.
 *
 * Two states per the UI-SPEC Screen States:
 *   1. No verified server → dominant "Set up your SMTP server" soft-gate callout.
 *   2. ≥1 verified server → readiness confirmed ("At least one verified SMTP
 *      server") with the default server summarised.
 *
 * Security (T-2-IDOR / T-2-CRED / T-061-12): servers are listed via the
 * SERVER-derived Clerk userId (never a client id) and only DTO fields (via
 * toSmtpConfigDto) are read; the encrypted password triple is never referenced,
 * so it cannot reach the client.
 */
export default async function DashboardPage() {
  const { userId } = await auth();
  const rows = userId ? await listSmtpConfigsForUser(userId) : [];
  const configs = rows.map(toSmtpConfigDto);
  const verified = configs.filter((c) => c.verified_at !== null);

  // State 1 — no verified server: the soft-gate callout is the dominant element.
  if (verified.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-[28px] font-semibold leading-[1.2]">Dashboard</h1>
        <Card className="py-12">
          <CardHeader className="items-center text-center">
            <CardTitle className="text-xl">Connect your email server</CardTitle>
            <CardDescription className="text-base">
              Mail Merge sends through your own SMTP server — you stay in control
              of your sending. Set it up once and it&apos;s saved for every
              campaign.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button asChild>
              <Link href="/settings/smtp">Set up your SMTP server</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // The default server (or the first verified one when none is marked default)
  // is the account's headline sending identity.
  const primary = verified.find((c) => c.is_default) ?? verified[0];
  const fromLine = primary.from_name
    ? `${primary.from_name} <${primary.from_addr}>`
    : primary.from_addr;
  const extraCount = verified.length - 1;

  // State 2 — ready: readiness confirmed with the default server summarised.
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-[1.2]">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">SMTP servers</CardTitle>
          <CardDescription className="text-base">
            Your sending is ready to go.
          </CardDescription>
          <CardAction>
            <Badge variant="outline" className="text-success">
              <CheckCircle2 />
              Ready
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-4" />
            <span>At least one verified SMTP server</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Default</span>
            <span>
              {primary.label ?? "Untitled server"} — {primary.host}:
              {primary.port}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">From</span>
            <span>{fromLine}</span>
          </div>
          {extraCount > 0 ? (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Other servers</span>
              <span>
                {extraCount} more verified{" "}
                {extraCount === 1 ? "server" : "servers"}
              </span>
            </div>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline">
            <Link href="/settings/smtp">Manage SMTP servers</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
