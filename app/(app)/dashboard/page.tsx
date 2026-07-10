import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { CheckCircle2 } from "lucide-react";

import { getSmtpConfigForUser, toSmtpConfigDto } from "@/lib/data/smtp";
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
 * next action (D-02 soft gate).
 *
 * Three states per the UI-SPEC Screen States:
 *   1. No smtp_config    → dominant "Set up your SMTP server" callout.
 *   2. Config + verified → summary card with a "Verified" badge.
 *   3. Config, verified_at cleared by an edit → same summary card but a neutral
 *      "Re-verify required" badge (NOT destructive) + a CTA back into the wizard.
 *
 * Security (T-2-IDOR / T-2-CRED): the config is fetched via
 * getSmtpConfigForUser scoped to the SERVER-derived Clerk userId — never a
 * client-supplied id — and only DTO fields (via toSmtpConfigDto) are read; the
 * encrypted password triple is never referenced, so it cannot reach the client.
 */
export default async function DashboardPage() {
  const { userId } = await auth();
  const row = userId ? await getSmtpConfigForUser(userId) : undefined;

  // State 1 — fresh account: the soft-gate callout is the dominant element.
  if (!row) {
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

  const config = toSmtpConfigDto(row);
  const verified = config.verified_at !== null;
  const fromLine = config.from_name
    ? `${config.from_name} <${config.from_addr}>`
    : config.from_addr;

  // States 2 & 3 — configured account: summary card with a verified /
  // re-verify-required badge.
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-[1.2]">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">SMTP server</CardTitle>
          <CardDescription className="text-base">
            Your sending configuration.
          </CardDescription>
          <CardAction>
            {verified ? (
              <Badge variant="outline" className="text-success">
                <CheckCircle2 />
                Verified
              </Badge>
            ) : (
              <Badge variant="outline">Re-verify required</Badge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Host</span>
            <span>
              {config.host}:{config.port}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">From</span>
            <span>{fromLine}</span>
          </div>
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline">
            <Link href="/settings/smtp">
              {verified ? "Edit SMTP settings" : "Re-verify connection"}
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
