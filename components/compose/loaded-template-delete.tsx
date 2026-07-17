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
 * LoadedTemplateDelete — the in-compose destructive confirm island for the template
 * currently LOADED in the editor (tdl). Mirrors components/templates/template-delete.tsx
 * VERBATIM in structure: a `deleting` in-flight flag disables both dialog buttons
 * (double-submit guard), the AlertDialogAction calls e.preventDefault() so an in_use
 * result keeps the dialog open, an inline destructive Alert surfaces the in_use case,
 * and sonner + a router.refresh() reconcile the reuse picker on success.
 *
 * Difference from the list-surface variant: a labelled trigger button suited to
 * compose (not the icon-only list control), and an in_use ESCAPE HATCH — a "Clear
 * fields anyway" button that blanks the editor (via onCleared) WITHOUT deleting, so
 * the user can start from scratch even though a campaign references the template.
 *
 * SECURITY: the client only ever proposes `templateId`; deleteTemplate re-derives
 * userId server-side and owner-scopes the delete (T-tdl-IDOR-2 / IDOR).
 */
export function LoadedTemplateDelete({
  templateId,
  onCleared,
}: {
  templateId: number;
  onCleared: () => void;
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
    const res = await deleteTemplate(templateId);
    setDeleting(false);

    if (res.ok) {
      toast.success("Template deleted.");
      onCleared();
      setOpen(false);
      // The reuse picker is server-fetched, so refresh to drop the removed row.
      router.refresh();
      return;
    }

    // In-use guard: a campaign references this template — keep it (and the dialog),
    // surface the friendly Alert, and offer the local clear-fields escape hatch below.
    if (res.error.kind === "in_use") {
      setInUse(true);
      return;
    }
    toast.error("We couldn't delete this template. Try again.");
  }

  // Escape hatch (tdl): blank the editor and hide the affordance WITHOUT deleting,
  // so an in_use template can still be cleared to start from scratch.
  function onClearFields() {
    onCleared();
    setOpen(false);
    setInUse(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
          Delete template
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this template?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the saved template and clears the editor. This can&apos;t be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {inUse ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Template in use</AlertTitle>
            <AlertDescription>
              A campaign used this template, so it can&apos;t be deleted while that
              send history exists. You can still clear the fields and start from
              scratch.
            </AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          {inUse ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onClearFields}
            >
              Clear fields anyway
            </Button>
          ) : null}
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
