"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  ServerOff,
  Star,
  Trash2,
} from "lucide-react";

import type { SmtpConfigDto } from "@/lib/data/smtp";
import { deleteServer, setDefaultServer } from "@/lib/smtp/actions";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SmtpWizard } from "@/components/smtp/smtp-wizard";

/**
 * ServerList — the client island for the multi-server settings surface (06.1
 * MSMTP-01/05). The RSC (app/(app)/settings/smtp/page.tsx) lists the caller's
 * configs through the redacted `toSmtpConfigDto` and hands this island a DTO[]
 * (never the encrypted password triple — T-061-12). This island owns:
 *
 *  - the create/edit wizard swap (reusing SmtpWizard per server),
 *  - set-default (transactional swap via setDefaultServer) with a double-submit
 *    guard + router.refresh(),
 *  - the destructive delete AlertDialog with the in-use guard (a queued/running
 *    campaign keeps the row and surfaces the in-use Alert — SC5),
 *  - the no-default "choose a server" callout (NO auto-promote — LOCKED).
 *
 * SECURITY (T-061-13 IDOR): the client only ever proposes an id; setDefaultServer
 * / deleteServer re-derive the userId server-side and owner-resolve the id.
 */

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; config: SmtpConfigDto };

type DeleteError = "in_use" | "failed";

/** A readable name for a row whose label is somehow absent (defensive). */
function serverName(config: SmtpConfigDto): string {
  return config.label ?? "Untitled server";
}

export function ServerList({
  configs,
  testEmailDefault,
}: {
  configs: SmtpConfigDto[];
  testEmailDefault: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmtpConfigDto | null>(null);
  const [deleteError, setDeleteError] = useState<DeleteError | null>(null);
  const [deleting, setDeleting] = useState(false);

  const backToList = () => {
    setMode({ kind: "list" });
    router.refresh();
  };

  // ---- Wizard (create / edit) ----
  if (mode.kind === "create" || mode.kind === "edit") {
    return (
      <SmtpWizard
        initial={mode.kind === "edit" ? mode.config : null}
        testEmailDefault={testEmailDefault}
        onExit={backToList}
      />
    );
  }

  const hasDefault = configs.some((c) => c.is_default);

  async function onMakeDefault(config: SmtpConfigDto) {
    if (busyId !== null) return; // double-submit guard
    setBusyId(config.id);
    const res = await setDefaultServer(config.id);
    setBusyId(null);
    if (res.ok) {
      toast.success(`‘${serverName(config)}’ is now your default server.`);
      router.refresh();
      return;
    }
    toast.error("We couldn't update your default server. Try again.");
  }

  function openDelete(config: SmtpConfigDto) {
    setDeleteError(null);
    setDeleteTarget(config);
  }

  function closeDelete(open: boolean) {
    if (open || deleting) return; // don't close mid-delete
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await deleteServer(deleteTarget.id);
    setDeleting(false);
    if (res.ok) {
      toast.success("Server deleted.");
      setDeleteTarget(null);
      router.refresh();
      return;
    }
    // In-use guard: keep the dialog open and the row intact (SC5).
    setDeleteError(res.error.kind === "in_use" ? "in_use" : "failed");
  }

  // ---- Empty state (brand-new account) ----
  if (configs.length === 0) {
    return (
      <Card className="py-12">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <ServerOff className="size-8 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold leading-[1.2]">
              No servers yet
            </h2>
            <p className="text-base text-muted-foreground">
              Add your first SMTP server to start sending. We&apos;ll verify the
              connection before it&apos;s saved.
            </p>
          </div>
          <Button onClick={() => setMode({ kind: "create" })}>
            <Plus />
            Add server
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ---- Populated list ----
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <Button onClick={() => setMode({ kind: "create" })}>
          <Plus />
          Add server
        </Button>
      </div>

      {!hasDefault ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>No default server</AlertTitle>
          <AlertDescription>
            New campaigns won&apos;t have one pre-selected until you choose. Use
            &lsquo;Make default&rsquo; on the server you want.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="flex flex-col divide-y">
          {configs.map((config) => (
            <div
              key={config.id}
              className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-semibold leading-[1.2]">
                    {serverName(config)}
                  </h3>
                  {config.is_default ? (
                    <Badge variant="secondary">
                      <Star />
                      Default
                    </Badge>
                  ) : null}
                  {config.verified_at !== null ? (
                    <Badge variant="secondary" className="text-success">
                      <CheckCircle2 />
                      Verified
                    </Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {config.host}:{config.port} · {config.from_addr}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {!config.is_default ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => onMakeDefault(config)}
                  >
                    {busyId === config.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Star />
                    )}
                    Make default
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode({ kind: "edit", config })}
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => openDelete(config)}
                >
                  <Trash2 />
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={closeDelete}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this server?</AlertDialogTitle>
            <AlertDialogDescription>
              &lsquo;{deleteTarget ? serverName(deleteTarget) : ""}&rsquo; will
              be removed from your servers and can&apos;t be picked for new
              campaigns. Campaigns that already used it stay in your history.
              This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError === "in_use" ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Server in use</AlertTitle>
              <AlertDescription>
                This server is in use — a campaign is queued or sending through
                it right now. Wait for that send to finish, then delete it.
              </AlertDescription>
            </Alert>
          ) : null}

          {deleteError === "failed" ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Couldn&apos;t delete server</AlertTitle>
              <AlertDescription>
                We couldn&apos;t delete this server. Try again, and if it keeps
                failing, refresh the page.
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
                void onConfirmDelete();
              }}
            >
              {deleting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete server"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
