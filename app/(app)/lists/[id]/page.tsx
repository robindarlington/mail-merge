import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { getRecipientSetForUser } from "@/lib/data";
import { readUpload } from "@/lib/csv/storage";
import { parseCsv } from "@/lib/core/csv";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ListRename } from "@/components/recipients/list-rename";
import { ListDelete } from "@/components/recipients/list-delete";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

const CAP = 100;

/**
 * /lists/[id] — the CSV contents viewer for a single uploaded list. This RSC
 * enforces the IDOR gate structurally: the dynamic `[id]` segment is
 * integer-validated (notFound on a bad param before any DAL touch, T-dxm-02), then
 * read ONLY via the userId-scoped `getRecipientSetForUser` — an id owned by another
 * tenant (or absent) resolves to notFound(), never another user's data (T-dxm-01 /
 * AUTH-02). The stored CSV bytes are read via the traversal-guarded readUpload and
 * parsed to columns/rows; every cell renders as escaped JSX text only (no raw-HTML
 * injection sink) so attacker-influenced cell content can't inject markup
 * (T-dxm-03). The rows table is capped at the first 100 rows with a count note.
 */
export default async function ListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = Number.parseInt(id, 10);
  if (Number.isNaN(parsedId) || !Number.isInteger(parsedId)) notFound();

  const { userId } = await auth();
  if (!userId) notFound();

  const set = await getRecipientSetForUser(userId, parsedId);
  if (!set) notFound();

  const parsed = parseCsv(readUpload(set.storage_path));
  const columns = parsed.columns;
  const rows = parsed.rows;
  const shown = rows.slice(0, CAP);
  const capped = rows.length > CAP;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/lists"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to lists
        </Link>
        <div className="flex items-center gap-2 text-[28px] font-semibold leading-[1.2]">
          <ListRename id={set.id} currentName={set.label ?? set.filename} />
          <ListDelete
            id={set.id}
            name={set.label ?? set.filename}
            showName={false}
          />
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Filename</dt>
              <dd>{set.filename}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Uploaded</dt>
              <dd>{formatRelativeDate(set.created_at)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Rows</dt>
              <dd>{set.row_count}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">Columns</dt>
              <dd>{columns.length}</dd>
            </div>
          </dl>

          {columns.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground">Columns</span>
              <div className="flex flex-wrap gap-1.5">
                {columns.map((col) => (
                  <Badge key={col} variant="secondary">
                    {col}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {columns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This CSV has no columns to display.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <TableHead key={col}>{col}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {columns.map((col) => (
                    <TableCell key={`${rowIndex}:${col}`}>
                      {row[col] ?? ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {capped && (
            <p className="text-sm text-muted-foreground">
              Showing first {CAP} of {rows.length} rows
            </p>
          )}
        </div>
      )}
    </div>
  );
}
