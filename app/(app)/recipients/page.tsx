import { auth } from "@clerk/nextjs/server";
import { FileSpreadsheet } from "lucide-react";

import { listRecipientSetsForUser } from "@/lib/data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CsvUploader } from "@/components/recipients/csv-uploader";

/**
 * /recipients — the CSV upload + review + save surface (CSV-01/03/04/05, read
 * side CSV-05). This RSC mirrors settings/smtp/page.tsx: it re-derives the Clerk
 * `userId` server-side and lists ONLY that user's recipient sets via the
 * userId-scoped DAL (listRecipientSetsForUser) — an unauthenticated load yields
 * an empty list, never another tenant's sets (T-3-IDOR / AUTH-02). No secret data
 * crosses to the client; the uploader is self-contained.
 */

/** Human-friendly relative date from a unixepoch-seconds timestamp (RSC-only, static). */
function formatRelativeDate(unixSeconds: number): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diffSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === "second") {
      return rtf.format(Math.round(diffSeconds / secs), unit);
    }
  }
  return "just now";
}

export default async function RecipientsPage() {
  const { userId } = await auth();
  const sets = userId ? await listRecipientSetsForUser(userId) : [];

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-[1.2]">Recipients</h1>

      {sets.length === 0 ? (
        <Card className="py-12">
          <CardHeader className="items-center text-center">
            <CardTitle className="text-xl">
              Upload your first recipient list
            </CardTitle>
            <CardDescription className="text-base">
              Upload a CSV and Mail Merge detects your columns and finds the email
              address field. You confirm the details before it&apos;s saved for
              your campaigns.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col divide-y">
            {sets.map((set) => (
              <div
                key={set.id}
                className="flex items-center gap-2 py-3 text-sm first:pt-0 last:pb-0"
              >
                <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" />
                <span>
                  {set.filename} — {set.row_count} recipients ·{" "}
                  {formatRelativeDate(set.created_at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <CsvUploader />
    </div>
  );
}
