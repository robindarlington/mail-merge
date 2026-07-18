import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  Activity,
  CheckCircle2,
  Eye,
  FileText,
  KeyRound,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * Public landing at `/` (D-7). Route groups are URL-transparent, so this file at
 * the (marketing) group root serves `/` while inheriting the marketing header +
 * footer. A signed-in visitor is redirected server-side to /dashboard BEFORE any
 * markup renders, so there is no landing flash (RESEARCH Pitfall 2). All copy is
 * fixed by the UI-SPEC Copywriting Contract (Landing table) — honest,
 * sentence-case, no fabricated metrics. The single page accent is the "Get
 * started" CTA; every inline link is neutral underlined text (D-5).
 */

const features = [
  { icon: ShieldCheck, text: "Your own SMTP, verified before any send" },
  { icon: Sparkles, text: "Merge-field autocomplete for subject and body" },
  { icon: Eye, text: "Row-by-row preview with empty-value warnings" },
  { icon: Send, text: "Whole-batch test-send to one address" },
  { icon: CheckCircle2, text: "A confirmation gate before every live send" },
  {
    icon: Activity,
    text: "Live per-recipient progress and a downloadable record",
  },
  { icon: Terminal, text: "A CLI and MCP server for agents and scripts" },
];

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-16">
        <h1 className="max-w-3xl text-[28px] font-semibold leading-[1.2] sm:text-4xl lg:text-5xl">
          Send one personalized email per row of your CSV — over your own SMTP.
        </h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          A self-serve mail merge for plain-text email. Upload a CSV, compose
          with merge fields, preview and test-send, then fire a batch through
          your own SMTP server — with live progress and a record of exactly what
          was sent.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild>
            <Link href="/sign-up">Get started</Link>
          </Button>
          <Link
            href="/docs"
            className="text-base underline underline-offset-4 hover:text-foreground"
          >
            See the docs
          </Link>
        </div>
      </section>

      <Separator />

      {/* Built for two jobs */}
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12">
        <h2 className="text-xl font-semibold">Built for two jobs</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <KeyRound
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-xl">Credential delivery</CardTitle>
              <CardDescription className="text-base">
                Send each person their own login, token, or access details — one
                row, one email, no shared inbox.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <FileText
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-xl">Per-row documents</CardTitle>
              <CardDescription className="text-base">
                Attach a different file to each recipient — payslips,
                certificates, invoices — matched from a column in your CSV.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      <Separator />

      {/* What you get */}
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
        <h2 className="text-xl font-semibold">What you get</h2>
        <ul className="flex flex-col gap-4">
          {features.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-2">
              <Icon
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="text-base">{text}</span>
            </li>
          ))}
        </ul>
        <p className="text-base text-muted-foreground">
          Bring your own SMTP. Credentials are encrypted at rest. No shared
          sending infrastructure, no tracking pixels, no lock-in.
        </p>
      </section>

      <Separator />

      {/* Foot CTA */}
      <section className="mx-auto flex w-full max-w-3xl flex-col items-start gap-4 px-6 py-12">
        <Button asChild>
          <Link href="/sign-up">Get started</Link>
        </Button>
      </section>
    </div>
  );
}
