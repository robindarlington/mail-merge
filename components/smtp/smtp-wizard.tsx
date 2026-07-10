"use client";

import { useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2 } from "lucide-react";

import { smtpFormSchema, type SmtpFormValues } from "@/lib/smtp";
import type { SmtpConfigDto } from "@/lib/data/smtp";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { StepDetails } from "@/components/smtp/step-details";

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

export function SmtpWizard({
  initial,
  testEmailDefault,
}: {
  initial: SmtpConfigDto | null;
  testEmailDefault: string;
}) {
  const isEdit = initial !== null;
  const [step, setStep] = useState(0);

  const form = useForm<SmtpFormValues>({
    // `port` uses z.coerce, so the schema's INPUT type (port: unknown) diverges
    // from its OUTPUT type (port: number). We drive the form with the clean
    // output type and cast the resolver — the port control renders/edits as a
    // string and the shared schema coerces it on submit (and again server-side).
    resolver: zodResolver(smtpFormSchema) as unknown as Resolver<SmtpFormValues>,
    defaultValues: {
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

  // Client-side gate: advance to step 2 only when the details validate (D-01).
  const onContinue = form.handleSubmit(() => setStep(1));

  return (
    <Card>
      <CardContent className="flex flex-col gap-12">
        <Stepper current={step} />

        <Form {...form}>
          {step === 0 ? (
            <div className="flex flex-col gap-8">
              <StepDetails form={form} isEdit={isEdit} disabled={false} />
              <div className="flex justify-end">
                <Button type="button" onClick={() => onContinue()}>
                  Verify &amp; continue
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Verify and test-send steps are wired next.
            </p>
          )}
        </Form>
      </CardContent>
    </Card>
  );
}
