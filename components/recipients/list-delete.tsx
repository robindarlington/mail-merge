"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Loader2, Trash2 } from "lucide-react";

import { deleteList } from "@/lib/csv/actions";
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
 * ListDelete — the destructive confirm island for a saved list (mdt). Mirrors
 * list-rename.tsx's footprint (a small ghost affordance sitting inline in the Lists
 * row and on the detail header) and server-list.tsx's delete pattern: a `deleting`
 * in-flight flag disables both dialog buttons (double-submit guard, T-mdt-04), the
 * AlertDialogAction calls e.preventDefault() so an in_use result keeps the dialog
 * open, and sonner surfaces the outcome.
 *
 * A list referenced by any campaign is blocked server-side (in_use); the island
 * shows an inline Alert and leaves the list intact. On { ok:true } → toast +
 * router.refresh() so the Lists surface drops the removed row.
 *
 * SECURITY: the client only ever proposes `id`; deleteList re-derives userId server
 * side and owner-scopes the delete (T-mdt-01 / IDOR).
 *
 * `showName` (default true): the detail header renders the name beside the trash
 * affordance, while the Lists row (name already inside its navigable Link) passes
 * showName={false} so only the icon button shows — no duplicate name.
 */
export function ListDelete({
  id,
  name,
  showName = true,
}: {
  id: number;
  name: string;
  showName?: boolean;
}) {
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
    const res = await deleteList(id);
    setDeleting(false);

    if (res.ok) {
      toast.success("List deleted.");
      setOpen(false);
      router.refresh();
      return;
    }

    // In-use guard: a campaign references this list — keep it (and the dialog).
    if (res.error.kind === "in_use") {
      setInUse(true);
      return;
    }
    toast.error("We couldn't delete this list. Try again.");
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={showName ? "sm" : "icon-sm"}
          aria-label="Delete list"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
          {showName ? "Delete" : null}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this list?</AlertDialogTitle>
          <AlertDialogDescription>
            &lsquo;{name}&rsquo; and its uploaded CSV will be removed. This
            can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>List in use</AlertTitle>
            <AlertDescription>
              A campaign uses this list, so it can&apos;t be deleted while that
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
              "Delete list"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
