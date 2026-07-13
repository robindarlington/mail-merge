"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertCircle, Loader2, Save } from "lucide-react";

import {
  previewCampaign,
  saveTemplate,
  type PreviewReport,
} from "@/lib/compose/actions";
import { composeFormSchema, type ComposeFormValues } from "@/lib/compose/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MergeFieldMenu } from "@/components/compose/merge-field-menu";
import { PreviewStepper } from "@/components/compose/preview-stepper";
import { SendCard } from "@/components/campaign/send-card";

/**
 * ComposeEditor — the client shell for the compose slice (EDIT-01/02/04). It
 * mirrors the CSV uploader's react-hook-form + zod + action-call + typed-failure
 * + sonner-toast pattern, adding the merge-field autocomplete this phase needs.
 *
 * Flow:
 *   1. A `Select` picks one of the user's saved recipient lists; its columns come
 *      straight from `columns_json` (no server round-trip — the columns feed the
 *      merge-field chips + `{{` autocomplete).
 *   2. A subject `Input` + body `Textarea` are wired to the SHARED
 *      `composeFormSchema` resolver (the SAME schema the server re-validates, so
 *      client + server can never diverge — T-4-CLIENTVAL).
 *   3. Merge fields insert as literal `{{column}}` text at the last-focused
 *      caret, via chip click OR the `{{`-triggered suggestion popover.
 *   4. Save posts subject/body to `saveTemplate`; success toasts, `validation`
 *      anchors field errors, `unauthenticated`/unknown surface a destructive
 *      Alert. The button is disabled while empty or in flight (no double-submit).
 *
 * Preview + validation report render NOWHERE here — that is Plan 05.
 */

type EditorSet = {
  id: number;
  filename: string;
  row_count: number;
  columns_json: string;
};

type FieldName = "subject" | "body";

/** Which field triggered the `{{` popover, where the token starts, and its partial. */
type Autocomplete = { field: FieldName; start: number; filter: string };

/** Case-insensitive substring filter; an empty partial lists every column. */
function filterColumns(columns: string[], filter: string): string[] {
  const q = filter.trim().toLowerCase();
  if (!q) return columns;
  return columns.filter((column) => column.toLowerCase().includes(q));
}

/** Parse a recipient set's persisted columns_json into a string[] (never throws to render). */
function parseColumns(columnsJson: string): string[] {
  try {
    const parsed = JSON.parse(columnsJson);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export function ComposeEditor({
  sets,
  hasSmtpConfig,
  defaultTestEmail,
}: {
  sets: EditorSet[];
  hasSmtpConfig: boolean;
  defaultTestEmail: string;
}) {
  const form = useForm<ComposeFormValues>({
    resolver: zodResolver(composeFormSchema),
    defaultValues: { subject: "", body: "" },
  });

  const [selectedId, setSelectedId] = useState<string>(
    sets.length > 0 ? String(sets[0].id) : "",
  );
  // The most-recently saved standalone template id (A1/U7 — template save stays
  // standalone; re-saving creates a new row and updates this to the newest id).
  const [savedTemplateId, setSavedTemplateId] = useState<number | null>(null);
  const [autocomplete, setAutocomplete] = useState<Autocomplete | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Preview state — the rows/emailColumn/invalidEmailCount are fetched ONCE per
  // recipient-list change via previewCampaign (server-authoritative,
  // template-INDEPENDENT). The stepper walks the fetched rows client-side and
  // computes the template-DEPENDENT aggregates itself — no per-step/per-keystroke
  // round-trip.
  const [report, setReport] = useState<PreviewReport | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<{
    destructive: boolean;
    message: string;
  } | null>(null);

  // Field elements for caret-targeted insertion; the last-focused one is the
  // insert target after a chip click blurs the field.
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<FieldName>("body");

  const activeSet = useMemo(
    () => sets.find((set) => String(set.id) === selectedId) ?? null,
    [sets, selectedId],
  );
  const columns = useMemo(
    () => (activeSet ? parseColumns(activeSet.columns_json) : []),
    [activeSet],
  );

  // Fetch the preview rows + template-INDEPENDENT server fields ONCE per
  // recipient-list change (never per stepper step, never per keystroke — the
  // stepper walks report.rows client-side). The ignore flag drops a stale
  // response if the user switches lists mid-flight.
  useEffect(() => {
    if (!selectedId) {
      setReport(null);
      setPreviewError(null);
      return;
    }
    let ignore = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const fd = new FormData();
    fd.set("recipientSetId", selectedId);
    previewCampaign(fd)
      .then((res) => {
        if (ignore) return;
        if (res.ok) {
          setReport(res.data);
          return;
        }
        setReport(null);
        switch (res.error.kind) {
          case "unauthenticated":
            setPreviewError({
              destructive: true,
              message:
                "Your session has expired. Sign in again to preview your recipients.",
            });
            break;
          case "not_found":
            setPreviewError({
              destructive: false,
              message: "That list is no longer available.",
            });
            break;
          default:
            setPreviewError({
              destructive: false,
              message:
                "We couldn't load a preview for that list. Try selecting it again.",
            });
        }
      })
      .finally(() => {
        if (!ignore) setPreviewLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [selectedId]);

  const matches = autocomplete ? filterColumns(columns, autocomplete.filter) : [];

  const subject = form.watch("subject");
  const body = form.watch("body");

  function elFor(field: FieldName): HTMLInputElement | HTMLTextAreaElement | null {
    return field === "subject" ? subjectRef.current : bodyRef.current;
  }

  /** Move the caret to `pos` in `field` and refocus it after a value change. */
  function restoreCaret(field: FieldName, pos: number) {
    // Defer so React has committed the new value before we set the caret.
    requestAnimationFrame(() => {
      const el = elFor(field);
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  /** Detect a `{{partial` immediately before the caret and open/close the popover. */
  function detectAutocomplete(field: FieldName, el: HTMLInputElement | HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const match = before.match(/\{\{\s*([\w.-]*)$/);
    if (match) {
      setAutocomplete({ field, start: caret - match[0].length, filter: match[1] });
    } else {
      setAutocomplete(null);
    }
  }

  /** Insert `{{token}}` at the last-focused field's caret (chip click). */
  function insertChip(token: string) {
    const field = lastFocused.current;
    const el = elFor(field);
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const insertText = `{{${token}}}`;
    const next = el.value.slice(0, start) + insertText + el.value.slice(end);
    form.setValue(field, next, { shouldValidate: true, shouldDirty: true });
    setAutocomplete(null);
    restoreCaret(field, start + insertText.length);
  }

  /** Replace the active `{{partial` with `{{token}}` (autocomplete select). */
  function selectSuggestion(token: string) {
    if (!autocomplete) return;
    const { field, start } = autocomplete;
    const el = elFor(field);
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const insertText = `{{${token}}}`;
    const next = el.value.slice(0, start) + insertText + el.value.slice(caret);
    form.setValue(field, next, { shouldValidate: true, shouldDirty: true });
    setAutocomplete(null);
    restoreCaret(field, start + insertText.length);
  }

  /** Escape closes the popover; Enter picks the first match. */
  function handleKeyDown(field: FieldName, e: React.KeyboardEvent) {
    if (!autocomplete || autocomplete.field !== field) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setAutocomplete(null);
    } else if (e.key === "Enter" && matches.length > 0) {
      e.preventDefault();
      selectSuggestion(matches[0]);
    }
  }

  async function onSave(values: ComposeFormValues) {
    setSaveError(null);
    setSaving(true);

    const fd = new FormData();
    fd.set("subject", values.subject);
    fd.set("body", values.body);
    const res = await saveTemplate(fd);
    setSaving(false);

    if (res.ok) {
      setSavedTemplateId(res.data.id);
      toast.success("Template saved.");
      return;
    }

    switch (res.error.kind) {
      case "validation": {
        // Re-run the shared schema to anchor the error on the offending field(s).
        const parsed = composeFormSchema.safeParse({
          subject: values.subject,
          body: values.body,
        });
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            const path = issue.path[0];
            if (path === "subject" || path === "body") {
              form.setError(path, { message: issue.message });
            }
          }
        } else {
          setSaveError(
            "We couldn't save your template. Try again, and if it keeps failing, refresh the page and re-check your subject and message.",
          );
        }
        break;
      }
      case "unauthenticated":
        setSaveError(
          "Your session has expired. Sign in again to save your template.",
        );
        break;
      default:
        setSaveError(
          "We couldn't save your template. Try again, and if it keeps failing, refresh the page and re-check your subject and message.",
        );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="recipient-list">Recipient list</Label>
        <Select
          value={selectedId}
          onValueChange={(value) => {
            setSelectedId(value);
            setAutocomplete(null);
          }}
        >
          <SelectTrigger id="recipient-list" className="w-full">
            <SelectValue placeholder="Choose a recipient list" />
          </SelectTrigger>
          <SelectContent>
            {sets.map((set) => (
              <SelectItem key={set.id} value={String(set.id)}>
                {set.filename} — {set.row_count} recipients
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          Your merge fields come from this list&apos;s columns.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Compose your email</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSave)}
              className="flex flex-col gap-6"
            >
              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Your subject line — type {{ to add a merge field"
                        {...field}
                        ref={(el) => {
                          field.ref(el);
                          subjectRef.current = el;
                        }}
                        onChange={(e) => {
                          field.onChange(e);
                          detectAutocomplete("subject", e.target);
                        }}
                        onFocus={() => {
                          lastFocused.current = "subject";
                        }}
                        onClick={(e) => detectAutocomplete("subject", e.currentTarget)}
                        onKeyUp={(e) => detectAutocomplete("subject", e.currentTarget)}
                        onKeyDown={(e) => handleKeyDown("subject", e)}
                        onBlur={field.onBlur}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="body"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Message</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={10}
                        placeholder="Write your message. Type {{ to insert a merge field like {{name}}."
                        {...field}
                        ref={(el) => {
                          field.ref(el);
                          bodyRef.current = el;
                        }}
                        onChange={(e) => {
                          field.onChange(e);
                          detectAutocomplete("body", e.target);
                        }}
                        onFocus={() => {
                          lastFocused.current = "body";
                        }}
                        onClick={(e) => detectAutocomplete("body", e.currentTarget)}
                        onKeyUp={(e) => detectAutocomplete("body", e.currentTarget)}
                        onKeyDown={(e) => handleKeyDown("body", e)}
                        onBlur={field.onBlur}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <MergeFieldMenu
                columns={columns}
                onInsertChip={insertChip}
                open={autocomplete !== null && columns.length > 0}
                matches={matches}
                onOpenChange={(next) => {
                  if (!next) setAutocomplete(null);
                }}
                onSelect={selectSuggestion}
              />

              {saveError ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Couldn&apos;t save template</AlertTitle>
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex justify-end">
                <Button type="submit" disabled={saving || !subject || !body}>
                  {saving ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <Save />
                      Save template
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      {previewError ? (
        previewError.destructive ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn&apos;t load preview</AlertTitle>
            <AlertDescription>{previewError.message}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="size-4 shrink-0" />
            <span>{previewError.message}</span>
          </div>
        )
      ) : null}

      <PreviewStepper
        subject={subject}
        body={body}
        columns={columns}
        rows={report?.rows ?? []}
        totalRows={report?.totalRows ?? 0}
        emailColumn={report?.emailColumn ?? null}
        invalidEmailCount={report?.invalidEmailCount ?? 0}
        loading={previewLoading}
      />

      <SendCard
        recipientSetId={selectedId}
        templateId={savedTemplateId}
        recipientCount={activeSet?.row_count ?? 0}
        hasSmtpConfig={hasSmtpConfig}
        defaultTestEmail={defaultTestEmail}
      />
    </div>
  );
}
