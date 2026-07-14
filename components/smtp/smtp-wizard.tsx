"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, CheckCircle2 } from "lucide-react";

import {
  smtpEditFormSchema,
  smtpFormSchema,
  type SmtpFormValues,
} from "@/lib/smtp/schema";
import { createServer, updateServer } from "@/lib/smtp/actions";
import type { SmtpConfigDto } from "@/lib/data/smtp";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { StepDetails } from "@/components/smtp/step-details";
import { StepVerify } from "@/components/smtp/step-verify";
import { StepTestSend } from "@/components/smtp/step-test-send";

/**
 * SmtpWizard — the client shell for the three-step SMTP onboarding wizard AND the
 * edit flow (D-01). It owns the single `useForm` instance (so step 2 can
 * `setError` on step 1's controls), the current step, and the shared
 * verify-in-flight (`pending`) state that disables step 1's fields while a verify
 * runs.
 *
 * D-01 gating: each step gates the next — step 2 is unreachable without
 * client-valid details, and step 3 is unreachable until a verify succeeds.
 *
 * D-07 / T-2-CRED: `initial` is the password-free DTO. Edit mode prefills every
 * field from it EXCEPT the password, which starts blank ("leave blank to keep").
 */

const STEPS = ["Server details", "Verify", "Test send"] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-sm",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary text-primary",
                !done && !active && "border-border text-muted-foreground",
              )}
            >
              {done ? <CheckCircle2 className="size-4" /> : i + 1}
            </span>
            <span
              className={cn(
                "text-sm",
                active || done ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * WR-09 (LOCKED, client half): changing the host with a blank password must force
 * re-entry — a stored credential is never dialed against a host it wasn't verified
 * with. Kept identical to the server-side gate copy (actions-core.ts) for parity.
 */
const WR09_HOST_CHANGE_MESSAGE =
  "You changed the server host. Re-enter the password so we can verify it against the new host.";

export function SmtpWizard({
  initial,
  testEmailDefault,
  onExit,
}: {
  initial: SmtpConfigDto | null;
  testEmailDefault: string;
  /**
   * Where "done"/exit leads. When rendered from the settings server list, this
   * returns to the list (and refreshes it); when absent (legacy onboarding entry)
   * the wizard falls back to the dashboard.
   */
  onExit?: () => void;
}) {
  const isEdit = initial !== null;
  const configId = initial?.id ?? null;
  const initialHost = initial?.host ?? null;
  const router = useRouter();
  // Wizard stage: the details+verify screen, then the test-send screen. The
  // stepper's "Verify" marker lights while a verify is in flight (`pending`).
  const [stage, setStage] = useState<"details" | "test">("details");
  const [pending, setPending] = useState(false);
  // The id the test-send step addresses: the edited row's id up front, or the id
  // createServer returns once a NEW row is saved (create flow has no id earlier).
  const [savedId, setSavedId] = useState<number | null>(configId);

  const form = useForm<SmtpFormValues>({
    // `port` uses z.coerce, so the schema's INPUT type (port: unknown) diverges
    // from its OUTPUT type (port: number). We drive the form with the clean
    // output type and cast the resolver — the port control renders/edits as a
    // string and the shared schema coerces it on submit (and again server-side).
    // Edit mode relaxes the password to "leave blank to keep" (D-07); the create
    // flow keeps the base schema where a password is always required.
    resolver: zodResolver(
      isEdit ? smtpEditFormSchema : smtpFormSchema,
    ) as unknown as Resolver<SmtpFormValues>,
    defaultValues: {
      // Required, user-facing server name (06.1 multi-server). Prefilled on edit.
      label: initial?.label ?? "",
      host: initial?.host ?? "",
      // The port control is a string until zod coerces it; empty for a new form.
      port: initial?.port ?? 465,
      secure: initial?.secure ?? true,
      username: initial?.username ?? "",
      // D-07: never prefill the stored password — start blank.
      password: "",
      from_addr: initial?.from_addr ?? "",
      from_name: initial?.from_name ?? "",
    },
  });

  // D-08 routing: in edit mode, a from-only change saves directly; any connection
  // field (host/port/secure/username/password) re-routes through verify.
  const dirty = form.formState.dirtyFields;
  const connectionDirty = Boolean(
    dirty.host || dirty.port || dirty.secure || dirty.username || dirty.password,
  );

  // Stepper marker: details (0), verify while in flight (1), test send (2).
  const current = stage === "test" ? 2 : pending ? 1 : 0;

  const finish = () => {
    if (onExit) {
      onExit();
      return;
    }
    router.push("/dashboard");
    router.refresh();
  };

  // WR-09 client gate (LOCKED): on an edit where the host changed and the password
  // is left blank, block the verify/save and return the field message so StepVerify
  // can anchor it on the password control. Re-entering a password clears the gate.
  const hostChangeGate = (values: SmtpFormValues): string | null => {
    if (!isEdit) return null;
    const hostChanged = values.host.trim() !== (initialHost ?? "").trim();
    if (hostChanged && values.password === "") return WR09_HOST_CHANGE_MESSAGE;
    return null;
  };

  // Persist via the id-scoped create/update actions (replacing the retired
  // single-config verify-and-save): a null id inserts a NEW named server, an id
  // updates that owned row. Both verify-then-save server-side; a failure saves
  // nothing. The result's id is captured so StepTestSend can address the
  // just-saved server.
  const persist = async (values: SmtpFormValues) => {
    const res =
      configId === null
        ? await createServer(values)
        : await updateServer(configId, values);
    if (res.ok && res.id !== undefined) setSavedId(res.id);
    return res;
  };

  const title = isEdit ? "Edit server" : "Add an SMTP server";

  return (
    <Card>
      <CardContent className="flex flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold leading-[1.2]">{title}</h2>
          {onExit ? (
            <Button type="button" variant="ghost" size="sm" onClick={onExit}>
              <ArrowLeft />
              Back to servers
            </Button>
          ) : null}
        </div>

        <Stepper current={current} />

        <Form {...form}>
          {stage === "details" ? (
            <div className="flex flex-col gap-8">
              <StepDetails form={form} isEdit={isEdit} disabled={pending} />
              <StepVerify
                form={form}
                isEdit={isEdit}
                connectionDirty={connectionDirty}
                pending={pending}
                persist={persist}
                hostChangeGate={hostChangeGate}
                onPendingChange={setPending}
                onVerified={() => setStage("test")}
                onComplete={finish}
              />
            </div>
          ) : (
            <StepTestSend
              configId={savedId}
              defaultEmail={testEmailDefault}
              onComplete={finish}
            />
          )}
        </Form>
      </CardContent>
    </Card>
  );
}
