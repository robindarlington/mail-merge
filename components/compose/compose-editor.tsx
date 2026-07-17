"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertCircle, Loader2, Save } from "lucide-react";

import {
  previewCampaign,
  saveTemplate,
  type PreviewReport,
  type ResolvedInitialTemplate,
} from "@/lib/compose/actions";
import { composeFormSchema, type ComposeFormValues } from "@/lib/compose/schema";
import type { SmtpConfigDto } from "@/lib/data";
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
import { LoadedTemplateDelete } from "@/components/compose/loaded-template-delete";
import { getCaretRect } from "@/components/compose/caret-coords";
import { PreviewStepper } from "@/components/compose/preview-stepper";
import { SendCard } from "@/components/campaign/send-card";
import { AttachmentsCard } from "@/components/compose/attachments-card";
import {
  matchAttachments,
  confirmAttachmentColumn,
  type AttachmentListResult,
  type AttachmentMatch,
} from "@/lib/attachments/actions";

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

/** A reusable saved template scoped to this list (tpl) — id + the fillable pair. */
type SavedTemplate = {
  id: number;
  subject: string;
  body: string;
};

type EditorSet = {
  id: number;
  filename: string;
  label: string | null;
  row_count: number;
  columns_json: string;
  attachment_column: string | null;
  templates: SavedTemplate[];
};

/** The uploaded-attachment row shape the DAL returns (id + filename + size). */
type UploadedAttachment = Extract<
  AttachmentListResult,
  { ok: true }
>["data"][number];

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

/** The initial server selection (06.1 multi-server, CONTEXT.md LOCKED): the account
 *  default when present, else the sole verified server when exactly one exists
 *  (zero-click auto-select — NOT a silent promote), else null (the no-default,
 *  multiple-servers "choose a server" state). */
function initialSmtpConfigId(configs: SmtpConfigDto[]): number | null {
  const preferred = configs.find((c) => c.is_default);
  if (preferred) return preferred.id;
  if (configs.length === 1) return configs[0].id;
  return null;
}

export function ComposeEditor({
  sets,
  configs,
  defaultTestEmail,
  initialAttachments,
  initialTemplate,
}: {
  sets: EditorSet[];
  configs: SmtpConfigDto[];
  defaultTestEmail: string;
  initialAttachments: UploadedAttachment[];
  initialTemplate?: ResolvedInitialTemplate | null;
}) {
  const router = useRouter();

  // Deep-link preselection (tdl): when /compose?template=<id> resolved an owned
  // template, open on the template's list; otherwise the first list. Reuses the SAME
  // savedTemplateId + field-fill contract loadTemplate() establishes — no parallel
  // load path, no mount effect (lazy initializers below → no flash). initialSet
  // stays sets[0] when the template is unscoped OR its list isn't in `sets`.
  const initialSet =
    (initialTemplate?.recipientSetId != null
      ? sets.find((set) => set.id === initialTemplate.recipientSetId)
      : undefined) ??
    (sets.length > 0 ? sets[0] : undefined);

  const form = useForm<ComposeFormValues>({
    resolver: zodResolver(composeFormSchema),
    defaultValues: {
      subject: initialTemplate?.subject ?? "",
      body: initialTemplate?.body ?? "",
    },
  });

  const [selectedId, setSelectedId] = useState<string>(
    initialSet ? String(initialSet.id) : "",
  );
  // The chosen verified SMTP server the campaign sends through (proposed to the
  // server, which owner-re-resolves it). Auto-selected per initialSmtpConfigId.
  const [smtpConfigId, setSmtpConfigId] = useState<number | null>(() =>
    initialSmtpConfigId(configs),
  );
  // The most-recently saved standalone template id (A1/U7 — template save stays
  // standalone; re-saving creates a new row and updates this to the newest id). A
  // deep-linked template (tdl) seeds this so the loaded template is immediately
  // previewable/sendable AND deletable (Task 2) without a re-save.
  const [savedTemplateId, setSavedTemplateId] = useState<number | null>(
    initialTemplate?.id ?? null,
  );
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

  // Attachment state (ATCH-01/02/03) lifted here so the compose card, the send
  // gate, and the confirm dialog all see one source of truth. Uploaded files are
  // user-global PENDING uploads (not per-list), so they survive a list switch (W3);
  // the chosen column resets + re-detects per list. The `match` summary is ALWAYS
  // the server AttachmentMatch from matchAttachments — never derived client-side.
  const [attachments, setAttachments] =
    useState<UploadedAttachment[]>(initialAttachments);
  const [attachmentColumn, setAttachmentColumn] = useState<string | null>(
    initialSet ? initialSet.attachment_column : null,
  );
  const [attachmentMatch, setAttachmentMatch] =
    useState<AttachmentMatch | null>(null);

  // Field elements for caret-targeted insertion; the last-focused one is the
  // insert target after a chip click blurs the field.
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<FieldName>("body");

  // The caret's viewport rect, stored in a ref (not state — it feeds the virtual
  // popover anchor and must not trigger extra renders). detectAutocomplete keeps
  // it fresh; the virtual anchor below reads .current on each Radix measure.
  const caretRect = useRef<{ top: number; left: number; height: number } | null>(
    null,
  );
  const caretAnchorRef = useRef({
    getBoundingClientRect() {
      const c = caretRect.current ?? { top: 0, left: 0, height: 0 };
      return {
        top: c.top,
        left: c.left,
        bottom: c.top + c.height,
        right: c.left,
        width: 0,
        height: c.height,
        x: c.left,
        y: c.top,
        toJSON() {},
      } as DOMRect;
    },
  });

  const activeSet = useMemo(
    () => sets.find((set) => String(set.id) === selectedId) ?? null,
    [sets, selectedId],
  );
  const columns = useMemo(
    () => (activeSet ? parseColumns(activeSet.columns_json) : []),
    [activeSet],
  );

  // Re-fetch the server-authoritative attachment match for a set. The server
  // resolves the column from the set's PERSISTED choice (else auto-detect), so we
  // sync the local display column to whatever the server actually matched against
  // — this gives the auto-detect + confirmed-column behavior for free.
  const runMatch = useCallback(async (setId: string) => {
    if (!setId) {
      setAttachmentMatch(null);
      return;
    }
    const res = await matchAttachments(Number(setId));
    if (res.ok) {
      setAttachmentMatch(res.data);
      setAttachmentColumn(res.data.attachmentColumn);
    } else {
      setAttachmentMatch(null);
    }
  }, []);

  // Match once per recipient-list change (mount + switch). The card triggers
  // re-matches after upload/delete/column-change via the callbacks below.
  useEffect(() => {
    runMatch(selectedId);
  }, [selectedId, runMatch]);

  // After an upload/delete the card hands us the refreshed pending list; store it
  // and re-run the server match so matched/missing/oversize stay authoritative.
  function handleAttachmentsChange(list: UploadedAttachment[]) {
    setAttachments(list);
    void runMatch(selectedId);
  }

  // Persist the user's chosen column, THEN re-match (the server reads the persisted
  // column, never a client-supplied one).
  async function handleColumnChange(column: string) {
    setAttachmentColumn(column);
    if (selectedId) {
      await confirmAttachmentColumn(Number(selectedId), column);
      await runMatch(selectedId);
    }
  }

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
    // Capture any non-brace partial after `{{`, so a spaced column name
    // (e.g. `{{First N`) keeps the popover open and filtering — a space no
    // longer closes it. `start` stays `caret - match[0].length`.
    const match = before.match(/\{\{([^{}]*)$/);
    if (match) {
      caretRect.current = getCaretRect(el, caret);
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

  /** Load a saved template into the editor (tpl reuse): fill subject/body and mark
   *  it as the current template id so it is immediately previewable/sendable
   *  without a re-save. */
  function loadTemplate(templateId: string) {
    const template = activeSet?.templates.find(
      (t) => String(t.id) === templateId,
    );
    if (!template) return;
    form.setValue("subject", template.subject, { shouldValidate: true, shouldDirty: true });
    form.setValue("body", template.body, { shouldValidate: true, shouldDirty: true });
    setSavedTemplateId(template.id);
    setAutocomplete(null);
  }

  async function onSave(values: ComposeFormValues) {
    setSaveError(null);
    setSaving(true);

    const fd = new FormData();
    fd.set("subject", values.subject);
    fd.set("body", values.body);
    // Stamp the selected list so the saved template joins that list's library
    // (tpl key_link). The server owner-resolves the id before stamping.
    if (selectedId) fd.set("recipientSetId", selectedId);
    const res = await saveTemplate(fd);
    setSaving(false);

    if (res.ok) {
      setSavedTemplateId(res.data.id);
      toast.success("Template saved.");
      // The picker is server-fetched, so refresh to surface the new row (tpl).
      router.refresh();
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
            // Keep uploaded files, but reset the column to the new list's persisted
            // choice; the [selectedId] effect re-detects + re-matches (W3).
            const next = sets.find((set) => String(set.id) === value);
            setAttachmentColumn(next?.attachment_column ?? null);
          }}
        >
          <SelectTrigger id="recipient-list" className="w-full">
            <SelectValue placeholder="Choose a recipient list" />
          </SelectTrigger>
          <SelectContent>
            {sets.map((set) => (
              <SelectItem key={set.id} value={String(set.id)}>
                {set.label
                  ? `${set.label} (${set.filename}) — ${set.row_count} recipients`
                  : `${set.filename} — ${set.row_count} recipients`}
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
              {activeSet && activeSet.templates.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="saved-template">Saved templates</Label>
                  <Select value="" onValueChange={loadTemplate}>
                    <SelectTrigger id="saved-template" className="w-full">
                      <SelectValue placeholder="Load a saved template for this list" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSet.templates.map((template) => (
                        <SelectItem key={template.id} value={String(template.id)}>
                          {template.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">
                    Loading a template fills the subject and message below — ready to
                    preview and send.
                  </p>
                </div>
              ) : null}

              {/* In-compose delete (tdl): shown only when a template is LOADED
                  (savedTemplateId set — via deep link, reuse picker, or fresh save).
                  onCleared blanks the editor + hides this affordance for BOTH the
                  successful-delete and the in_use clear-fields paths. */}
              {savedTemplateId !== null ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3">
                  <p className="text-sm text-muted-foreground">
                    A saved template is loaded in this editor.
                  </p>
                  <LoadedTemplateDelete
                    templateId={savedTemplateId}
                    onCleared={() => {
                      form.setValue("subject", "", {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                      form.setValue("body", "", {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                      setSavedTemplateId(null);
                      setAutocomplete(null);
                    }}
                  />
                </div>
              ) : null}

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
                        onScroll={(e) => {
                          if (autocomplete?.field === "subject")
                            detectAutocomplete("subject", e.currentTarget);
                        }}
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
                        onScroll={(e) => {
                          if (autocomplete?.field === "body")
                            detectAutocomplete("body", e.currentTarget);
                        }}
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
                caretAnchorRef={caretAnchorRef}
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

      {selectedId ? (
        <AttachmentsCard
          selectedSetId={Number(selectedId)}
          columns={columns}
          rowCount={activeSet?.row_count ?? 0}
          attachments={attachments}
          attachmentColumn={attachmentColumn}
          match={attachmentMatch}
          onAttachmentsChange={handleAttachmentsChange}
          onColumnChange={handleColumnChange}
        />
      ) : null}

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
        configs={configs}
        smtpConfigId={smtpConfigId}
        onSelect={setSmtpConfigId}
        defaultTestEmail={defaultTestEmail}
      />
    </div>
  );
}
