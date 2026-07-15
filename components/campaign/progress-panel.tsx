"use client";

import { useEffect, useState } from "react";
import { Clock, Loader2 } from "lucide-react";

import { getCampaignProgress, type ProgressData } from "@/lib/campaign/actions";
import { Progress } from "@/components/ui/progress";
import { CampaignSummaryLine } from "@/components/campaign/campaign-summary-line";

/**
 * ProgressPanel (SEND-05) — the live-progress surface hosted on the campaign
 * detail page while a send is `queued`/`running`. It POLLS the userId-scoped
 * `getCampaignProgress` action every ~2s (06-RESEARCH.md A1: polling, not SSE) and
 * renders the server-authoritative counts. Every number here comes straight from
 * the server payload — `remaining` is the server-derived `data.remaining`, never
 * recomputed client-side from a cached list.
 *
 * Lifecycle:
 *  - Polls every POLL_INTERVAL_MS while status is non-terminal.
 *  - STOPS (the effect early-returns before scheduling, and the cleanup clears the
 *    interval) as soon as status is "completed" or "failed".
 *  - On a poll error it KEEPS the last-known counts and shows a muted, non-blocking
 *    "Couldn't refresh progress — retrying." line (Assumption U9) — it never blanks
 *    the UI or raises a destructive Alert; the poller self-heals on the next tick.
 *
 * The `{current}` recipient renders as escaped JSX text (a CSV-derived value), never
 * as HTML.
 */

const POLL_INTERVAL_MS = 2000;
const TERMINAL = new Set(["completed", "failed"]);

export function ProgressPanel({
  campaignId,
  initialStatus,
  initialProgress,
}: {
  campaignId: number;
  initialStatus: string;
  initialProgress?: ProgressData;
}) {
  const [progress, setProgress] = useState<ProgressData | null>(
    initialProgress ?? null,
  );
  const [status, setStatus] = useState(initialStatus);
  const [staleError, setStaleError] = useState(false);

  useEffect(() => {
    // Stop polling once terminal — no interval is scheduled at all.
    if (TERMINAL.has(status)) return;

    let active = true;
    async function poll() {
      const res = await getCampaignProgress({ campaignId });
      if (!active) return;
      if (!res.ok) {
        // Keep the last-known counts on screen; just flag the transient hiccup.
        setStaleError(true);
        return;
      }
      setStaleError(false);
      setProgress(res.data);
      setStatus(res.data.status);
    }

    poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [campaignId, status]);

  const total = progress?.total ?? 0;
  const sent = progress?.sent ?? 0;
  const failed = progress?.failed ?? 0;
  const remaining = progress?.remaining ?? 0;
  const current = progress?.current ?? null;
  const isTerminal = TERMINAL.has(status);
  const percent = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-6">
      {/* Header / bar: determinate once records materialize, queued otherwise. */}
      {total > 0 ? (
        <div className="flex flex-col gap-2">
          {!isTerminal ? (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Sending…</span>
            </div>
          ) : null}
          <Progress value={percent} />
        </div>
      ) : (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <Clock className="mt-0.5 size-4 shrink-0" />
          <span>
            Queued — waiting for the worker to pick this up. This usually starts
            within a few seconds.
          </span>
        </div>
      )}

      {/* Big live counts (Display 28px) with muted Label captions. */}
      <div className="flex gap-8">
        <div className="flex flex-col">
          <span className="text-[28px] font-semibold leading-[1.2] text-success">
            {sent}
          </span>
          <span className="text-sm text-muted-foreground">sent</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[28px] font-semibold leading-[1.2] text-destructive">
            {failed}
          </span>
          <span className="text-sm text-muted-foreground">failed</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[28px] font-semibold leading-[1.2]">
            {remaining}
          </span>
          <span className="text-sm text-muted-foreground">remaining</span>
        </div>
      </div>

      {/* Current recipient — only while a row is in flight. */}
      {current && !isTerminal ? (
        <p className="text-sm">Currently sending to {current}</p>
      ) : null}

      {/* Terminal summary (reached live, mid-poll) — shared copy with the detail RSC. */}
      {isTerminal ? (
        <CampaignSummaryLine
          status={status}
          total={total}
          sent={sent}
          failed={failed}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Live progress updates automatically. You can leave this page — the send
          continues in the background.
        </p>
      )}

      {/* Non-blocking poll-hiccup line; last-known counts stay on screen. */}
      {staleError && !isTerminal ? (
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t refresh progress — retrying.
        </p>
      ) : null}
    </div>
  );
}
