"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Pencil, X } from "lucide-react";

import { renameList } from "@/lib/csv/actions";
import { renameListSchema } from "@/lib/csv/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * ListRename — the inline-edit island for a saved list's display name (r8d). It
 * mirrors csv-uploader.tsx's seams: useRouter + useState for the input value /
 * pending / inline error, and the sonner toast + router.refresh() success flow.
 *
 * Display mode shows `currentName` with a ghost Pencil button. Clicking it swaps to
 * an edit row: a prefilled Input plus Save/Cancel. Save trims client-side and blocks
 * an empty value inline (never calling the action, so the old name is kept — WR guard);
 * the Save button disables while in flight (double-submit guard, T-3-DBLSUBMIT). On
 * { ok:true } → toast + exit + router.refresh(); a validation error shows inline copy;
 * any other error toasts a retry message.
 *
 * SECURITY: the client only ever proposes `id`; renameList re-derives userId server
 * side and owner-scopes the UPDATE (T-r8d-01 / IDOR) — this island never trusts id.
 *
 * `showName` (default true) controls display mode: the detail header renders the name
 * next to the pencil, while the Lists row keeps the name inside its navigable Link and
 * passes showName={false} so only the pencil affordance sits beside it (no duplicate).
 */
export function ListRename({
  id,
  currentName,
  showName = true,
}: {
  id: number;
  currentName: string;
  showName?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setValue(currentName);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    setValue(currentName);
  }

  async function onSave() {
    const trimmed = value.trim();

    // Client-side guard with the SHARED schema — an empty/oversize value never
    // reaches the action, so the old name is kept and the inline error shows.
    const check = renameListSchema.safeParse({ label: trimmed });
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "Give this list a name.");
      return;
    }

    setPending(true);
    setError(null);
    const res = await renameList(id, trimmed);
    setPending(false);

    if (res.ok) {
      toast.success("List renamed.");
      setEditing(false);
      router.refresh();
      return;
    }

    if (res.error.kind === "validation") {
      setError("Give this list a name of up to 60 characters.");
      return;
    }
    toast.error("We couldn't rename that list. Try again.");
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        {showName ? <span className="font-medium">{currentName}</span> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Rename list"
          onClick={startEdit}
        >
          <Pencil />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          autoFocus
          disabled={pending}
          maxLength={60}
          aria-label="List name"
          aria-invalid={error ? true : undefined}
          className="h-8 w-56"
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void onSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Save name"
          disabled={pending}
          onClick={() => void onSave()}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel rename"
          disabled={pending}
          onClick={cancelEdit}
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
