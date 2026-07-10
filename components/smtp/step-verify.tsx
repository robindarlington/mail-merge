"use client";

import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";

import type { SmtpFormValues } from "@/lib/smtp/schema";
import {
  verifyAndSave,
  updateFromFields,
  type ActionError,
} from "@/lib/smtp/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Step 2 of the wizard — verify-then-save (D-04) with field-anchored feedback
 * (D-06) and the one-click TLS switch (D-05). Rendered alongside step 1's fields
 * so a failure can point at the exact control that's wrong.
 *
 * "Verify & continue" runs `verifyAndSave(values)`: a clean verify saves the
 * encrypted config and advances to test-send; a failure saves NOTHING and maps
 * `error.field` onto the form's controls via `setError`. A TLS-shaped failure
 * that carries a `suggestion` offers a one-click "Switch to {mode} & verify".
 *
 * EDIT shortcut (D-08): when only the sender-identity fields changed
 * (`connectionDirty === false`), the primary action becomes "Save changes",
 * which calls `updateFromFields` directly WITHOUT a verify round-trip — a
 * display-name/address edit does not invalidate a proven connection.
 *
 * SECURITY (T-2-CRED / D-06): the "Show technical details" collapsible renders
 * `error.raw` — a message STRING only. The action contract never returns the
 * password or a raw Error object.
 */

const AUTH_MSG =
  "Username or password rejected by the server. Double-check your SMTP username and password.";
const TLS_MSG =
  "Secure connection failed. This usually means the wrong TLS mode for this server.";

type Detail = {
  message?: string;
  raw?: string;
  suggestion?: "starttls" | "implicit";
};

/** Human label for a suggested alternate TLS mode. */
function switchLabel(suggestion: "starttls" | "implicit"): string {
  return suggestion === "starttls" ? "STARTTLS" : "implicit SSL";
}

export function StepVerify({
  form,
  isEdit,
  connectionDirty,
  pending,
  onPendingChange,
  onVerified,
  onComplete,
}: {
  form: UseFormReturn<SmtpFormValues>;
  isEdit: boolean;
  connectionDirty: boolean;
  pending: boolean;
  onPendingChange: (v: boolean) => void;
  onVerified: () => void;
  onComplete: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);

  // Edit + only sender fields touched → save directly, no verify (D-08).
  const fromOnly = isEdit && !connectionDirty;

  function applyError(error: ActionError) {
    switch (error.kind) {
      case "unauthenticated":
        setDetail({
          message: "Your session has expired. Sign in again to continue.",
        });
        return;
      case "rate_limited":
        setDetail({
          message:
            "Too many verification attempts. Wait a minute, then try again.",
        });
        return;
      case "validation":
        setDetail({
          message: "Some details are invalid. Check the highlighted fields.",
        });
        return;
      case "send_failed":
        setDetail({ message: "Saving failed. Try again.", raw: error.raw });
        return;
      default: {
        const { field, raw, suggestion } = error;
        const { host, port } = form.getValues();
        if (field === "auth") {
          form.setError("username", { message: AUTH_MSG });
          form.setError("password", { message: AUTH_MSG });
        } else if (field === "hostPort") {
          const msg = `Couldn't reach ${host}:${port}. Check the host name and port, then try again.`;
          form.setError("host", { message: msg });
          form.setError("port", { message: msg });
        } else if (field === "tlsMode") {
          form.setError("secure", { message: TLS_MSG });
        }
        setDetail({
          message: field === "form" ? raw : undefined,
          raw,
          suggestion,
        });
      }
    }
  }

  // Verify-then-save. Gated on client zod validation via handleSubmit (D-01).
  async function runVerify() {
    form.clearErrors();
    setDetail(null);
    await form.handleSubmit(async (values) => {
      onPendingChange(true);
      const res = await verifyAndSave(values);
      onPendingChange(false);
      if (res.ok) {
        onVerified();
        return;
      }
      applyError(res.error);
    })();
  }

  // Sender-identity-only save (D-08): no verify, verified_at untouched.
  async function runFromOnly() {
    form.clearErrors();
    setDetail(null);
    const ok = await form.trigger(["from_addr", "from_name"]);
    if (!ok) return;
    const { from_addr, from_name } = form.getValues();
    onPendingChange(true);
    const res = await updateFromFields({ from_addr, from_name });
    onPendingChange(false);
    if (res.ok) {
      toast.success("Sender details saved.");
      onComplete();
      return;
    }
    applyError(res.error);
  }

  async function applySwitch() {
    if (!detail?.suggestion) return;
    form.setValue("secure", detail.suggestion === "implicit", {
      shouldDirty: true,
    });
    await runVerify();
  }

  const primaryLabel = fromOnly ? "Save changes" : "Verify & continue";
  const pendingLabel = fromOnly ? "Saving…" : "Verifying…";

  return (
    <div className="flex flex-col gap-4">
      {detail?.message ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>We couldn&apos;t continue</AlertTitle>
          <AlertDescription>{detail.message}</AlertDescription>
        </Alert>
      ) : null}

      {detail?.suggestion ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>Wrong TLS mode?</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              Your server needs {switchLabel(detail.suggestion)} — switch and
              continue?
            </span>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={applySwitch}
            >
              Switch to {switchLabel(detail.suggestion)} &amp; verify
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {detail?.raw ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              <ChevronDown />
              Show technical details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-2.5 text-sm text-muted-foreground">
              {detail.raw}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <div className="flex items-center justify-end gap-4">
        {pending && !fromOnly ? (
          <span className="text-sm text-muted-foreground">
            Connecting to your server — this can take up to 15 seconds.
          </span>
        ) : null}
        <Button
          type="button"
          disabled={pending}
          onClick={fromOnly ? runFromOnly : runVerify}
        >
          {pending ? (
            <>
              <Loader2 className="animate-spin" />
              {pendingLabel}
            </>
          ) : (
            <>
              {fromOnly ? null : <CheckCircle2 />}
              {primaryLabel}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
