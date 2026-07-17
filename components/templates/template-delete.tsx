"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";

import { deleteTemplate } from "@/lib/compose/actions";
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
 * TemplateDelete — the destructive confirm island for a saved template (tpl).
 * Mirrors components/recipients/list-delete.tsx VERBATIM in structure: a `deleting`
 * in-flight flag disables both dialog buttons (double-submit guard), the
 * AlertDialogAction calls e.preventDefault() so an in_use result keeps the dialog
 * open, an inline destructive Alert surfaces the in_use case, and sonner + a
 * router.refresh() reconcile the surface on success.
 *
 * A template referenced by any campaign is blocked server-side (in_use, D2); the
 * island shows the inline Alert and leaves the template intact so campaign history
 * stays whole. On { ok:true } → toast + router.refresh() drops the removed row.
 *
 * SECURITY: the client only ever proposes `id`; deleteTemplate re-derives userId
 * server-side and owner-scopes the delete (T-tpl-IDOR-2 / IDOR).
 */
export function TemplateDelete({ id, subject }: { id: number; subject: string }) {
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
    const res = await deleteTemplate(id);
    setDeleting(false);

    if (res.ok) {
      toast.success("Template deleted.");
      setOpen(false);
      router.refresh();
      return;
    }

    // In-use guard: a campaign references this template — keep it (and the dialog).
    if (res.error.kind === "in_use") {
      setInUse(true);
      return;
    }
    toast.error("We couldn't delete this template. Try again.");
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete template"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this template?</AlertDialogTitle>
          <AlertDialogDescription>
            &lsquo;{subject}&rsquo; will be removed from this list. This can&apos;t
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Template in use</AlertTitle>
            <AlertDescription>
              A campaign used this template, so it can&apos;t be deleted while that
              send history exists.
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
              "Delete template"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
