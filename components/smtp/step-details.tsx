"use client";

import type { UseFormReturn } from "react-hook-form";

import type { SmtpFormValues } from "@/lib/smtp";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";

/**
 * Step 1 of the SMTP wizard — the server-details form (SMTP-01 / SMTP-02).
 *
 * Presentational: it renders the six SMTP fields plus an EXPLICIT
 * "Connection security" radio bound to the form's `secure` boolean. The
 * `useForm` instance lives in the wizard so step 2 (verify) can `setError` on
 * these same controls; this component only renders the fields against it.
 *
 * SECURITY (D-07 / T-2-CRED): in edit mode every field prefills from the DTO
 * EXCEPT the password, which renders blank with "leave blank to keep" help — the
 * stored password never crosses to the client, so there is nothing here to
 * prefill it with.
 *
 * SMTP-02: the port never infers the TLS mode. Switching the radio only
 * default-SUGGESTS the conventional port (465/587) when the port is empty or
 * still holds the other mode's default — a user-entered port is never
 * overwritten, and the field stays freely editable.
 */
export function StepDetails({
  form,
  isEdit,
  disabled,
}: {
  form: UseFormReturn<SmtpFormValues>;
  isEdit: boolean;
  disabled: boolean;
}) {
  const suggestPortFor = (implicit: boolean) => {
    const current = String(form.getValues("port") ?? "").trim();
    // Only fill a conventional port when the user hasn't set a custom one.
    if (current === "" || current === "0" || current === "465" || current === "587") {
      form.setValue("port", implicit ? 465 : 587, { shouldDirty: true });
    }
  };

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold leading-[1.2]">Server details</h2>
          {isEdit ? (
            <p className="text-sm text-muted-foreground">
              Changing these settings requires re-verifying your connection.
            </p>
          ) : null}
        </div>

        <FormField
          control={form.control}
          name="host"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Host</FormLabel>
              <FormControl>
                <Input
                  placeholder="smtp.example.com"
                  autoComplete="off"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="port"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Port</FormLabel>
              <FormControl>
                <Input
                  inputMode="numeric"
                  placeholder="465"
                  {...field}
                  value={String(field.value ?? "")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="secure"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Connection security</FormLabel>
              <FormControl>
                <RadioGroup
                  value={field.value ? "implicit" : "starttls"}
                  onValueChange={(v) => {
                    const implicit = v === "implicit";
                    field.onChange(implicit);
                    suggestPortFor(implicit);
                  }}
                >
                  <label className="flex items-center gap-2 text-sm font-normal">
                    <RadioGroupItem value="implicit" />
                    Implicit SSL/TLS (usually port 465)
                  </label>
                  <label className="flex items-center gap-2 text-sm font-normal">
                    <RadioGroupItem value="starttls" />
                    STARTTLS (usually port 587)
                  </label>
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={isEdit ? "Leave blank to keep your current password" : undefined}
                  {...field}
                />
              </FormControl>
              {isEdit ? (
                <FormDescription>
                  Leave blank to keep your current password.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold leading-[1.2]">Sender identity</h2>

        <FormField
          control={form.control}
          name="from_addr"
          render={({ field }) => (
            <FormItem>
              <FormLabel>From address</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="off"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="from_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>From name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Your name or company"
                  autoComplete="off"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </section>
    </fieldset>
  );
}
