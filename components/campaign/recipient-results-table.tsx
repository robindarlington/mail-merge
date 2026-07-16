import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";

import type { SendRecord } from "@/lib/db/schema";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * RecipientResultsTable (HIST-02) — the per-recipient drill-down for one campaign.
 * A SERVER component (no "use client"): it renders static rows over the persisted
 * `send_records`; the sibling ProgressPanel handles live updates while a send runs.
 *
 * Per-recipient Status Vocabulary (06-UI-SPEC), enforced exactly:
 *   pending   → Clock, muted,            reason "—"
 *   sending   → Loader2 (spin),          reason "—"
 *   sent      → CheckCircle2, text-success, reason "—"
 *   failed    → XCircle, text-destructive,  reason = the stored message string
 *   failed (error "interrupted:…") → AlertTriangle, muted, label "Interrupted",
 *              reason "Interrupted — delivery status unknown; not retried to avoid
 *              a duplicate." (a delivery that MAY have succeeded — never red).
 *
 * to_addr and the reason render as escaped JSX text (CSV-derived, untrusted) — the
 * values are never injected as raw HTML (T-06-15 stored-XSS defense).
 */

const INTERRUPTED_PREFIX = "interrupted:";
/** The worker's stored reason for a row it skipped because the file was gone. */
const ATTACHMENT_MISSING_PREFIX = "rejected: attachment missing";

/** Human timestamp from unixepoch-seconds, e.g. "13 Jul 2026, 14:12"; "—" when null. */
function formatSentAt(unixSeconds: number | null): string {
  if (!unixSeconds) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function StatusCell({ record }: { record: SendRecord }) {
  const interrupted =
    record.status === "failed" &&
    (record.error ?? "").startsWith(INTERRUPTED_PREFIX);

  if (record.status === "sent") {
    return (
      <span className="flex items-center gap-1.5 text-success">
        <CheckCircle2 className="size-4 shrink-0" />
        Sent
      </span>
    );
  }
  if (record.status === "sending") {
    return (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        Sending
      </span>
    );
  }
  if (record.status === "failed") {
    if (interrupted) {
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0" />
          Interrupted
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-destructive">
        <XCircle className="size-4 shrink-0" />
        Failed
      </span>
    );
  }
  // pending (and any unknown pre-send state)
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <Clock className="size-4 shrink-0" />
      Pending
    </span>
  );
}

function reasonFor(record: SendRecord): string {
  if (record.status !== "failed") return "—";
  if ((record.error ?? "").startsWith(INTERRUPTED_PREFIX)) {
    return "Interrupted — delivery status unknown; not retried to avoid a duplicate.";
  }
  if ((record.error ?? "").startsWith(ATTACHMENT_MISSING_PREFIX)) {
    return "Attachment missing — the file wasn't available at send time. This email wasn't sent.";
  }
  return record.error ?? "—";
}

export function RecipientResultsTable({
  records,
  attachmentNames,
}: {
  records: SendRecord[];
  /** send_record id → original attachment filename (display-only, escaped). */
  attachmentNames?: Map<number, string>;
}) {
  if (records.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        <span>Preparing recipients…</span>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Recipient</TableHead>
          <TableHead>Attachment</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Sent at</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={record.id}>
            <TableCell>{record.to_addr}</TableCell>
            <TableCell className="text-muted-foreground">
              {attachmentNames?.get(record.id) ?? "—"}
            </TableCell>
            <TableCell>
              <StatusCell record={record} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {reasonFor(record)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatSentAt(record.sent_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
