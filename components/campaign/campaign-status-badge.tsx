import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/**
 * CampaignStatusBadge — the single source of truth for the fixed campaign-status
 * vocabulary (06-UI-SPEC Status Vocabulary), shared by the history list row and
 * the detail-page header so the label/icon/tone can never drift between them.
 *
 *   queued    → "Queued"    · secondary · Clock            (neutral, waiting)
 *   running   → "Sending"   · secondary · Loader2 (spin)   (neutral, live)
 *   completed → "Completed" · secondary · CheckCircle2     (text-success)
 *   failed    → "Failed"    · destructive · XCircle        (whole-campaign abort)
 *
 * A completed campaign that had some per-recipient failures is STILL "Completed"
 * (success-toned) — the muted "{failed} failed" note is rendered separately by the
 * caller, never folded into this badge. `draft` (never surfaced here) falls back to
 * the queued treatment defensively.
 */
export function CampaignStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" />
          Sending
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary">
          <CheckCircle2 className="text-success" />
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <XCircle />
          Failed
        </Badge>
      );
    case "queued":
    default:
      return (
        <Badge variant="secondary">
          <Clock />
          Queued
        </Badge>
      );
  }
}
