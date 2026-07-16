"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";

import { deleteCampaign } from "@/lib/campaign/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * DeleteCampaignButton — the destructive confirm island for the campaign detail
 * page (mdt). Mirrors components/smtp/server-list.tsx's delete block: a `deleting`
 * in-flight flag disables both dialog buttons (double-submit guard, T-mdt-04), the
 * AlertDialogAction calls e.preventDefault() so an in_use result keeps the dialog
 * open, and sonner surfaces the outcome.
 *
 * A queued/running campaign is blocked server-side (in_use); the island shows an
 * inline Alert and leaves the campaign intact. On { ok:true } the campaign is gone,
 * so we router.push('/campaigns') (a refresh-in-place would 404 the now-deleted
 * detail route).
 *
 * SECURITY: the client only ever proposes `campaignId`; deleteCampaign re-derives
 * userId server-side and owner-scopes the delete (T-mdt-01 / IDOR).
 */
export function DeleteCampaignButton({ campaignId }: { campaignId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [inUse, setInUse] = useState(false);

  function onOpenChange(next: boolean) {
    if (deleting) return; // don't close mid-delete
    setOpen(next);
    if (!next) setInUse(false);
  }

  async function onConfirm() {
    setDeleting(true);
    setInUse(false);
    const res = await deleteCampaign(campaignId);
    setDeleting(false);

    if (res.ok) {
      toast.success("Campaign deleted.");
      setOpen(false);
      // The detail route no longer exists — navigate to the history list.
      router.push("/campaigns");
      return;
    }

    // In-use guard: keep the dialog open and the campaign intact.
    if (res.error.kind === "in_use") {
      setInUse(true);
      return;
    }
    toast.error("We couldn't delete this campaign. Try again.");
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this campaign?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the campaign and its full send history — every
            per-recipient record and any attached files. This can&apos;t be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Campaign is sending</AlertTitle>
            <AlertDescription>
              A sender is actively working on this campaign right now — wait
              for it to finish (or, if it looks stuck, try again in a few
              minutes once its claim expires), then delete it.
            </AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(e) => {
              e.preventDefault(); // manage close ourselves (in-use keeps it open)
              void onConfirm();
            }}
          >
            {deleting ? (
              <>
                <Loader2 className="animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete campaign"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
