"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2, Paperclip, Upload, X } from "lucide-react";

import {
  uploadAttachment,
  deleteAttachment,
  type AttachmentListResult,
  type AttachmentMatch,
} from "@/lib/attachments/actions";
import { uploadAttachmentSchema } from "@/lib/attachments/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
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

/**
 * AttachmentsCard (ATCH-01/02/03) — the "Attachments (optional)" section on
 * /compose. A CONTROLLED client component: its uploaded-files list, chosen
 * attachment column, and the server `AttachmentMatch` summary all live in
 * ComposeEditor. This card uploads/deletes files (one `uploadAttachment` call per
 * file — the 10 MB body can't share a request), reports the refreshed list up so
 * the parent re-runs `matchAttachments`, and DISPLAYS the returned match summary
 * strictly from the `match` prop — it never derives matched/missing/oversize from
 * the cosmetic sample rows (T-07-18).
 *
 * Every filename renders as escaped JSX text (untrusted, like a CSV cell — the
 * T-06-15 stored-XSS rule).
 */

/** The uploaded-attachment row shape the DAL returns (id + filename + size). */
type UploadedAttachment = Extract<
  AttachmentListResult,
  { ok: true }
>["data"][number];

/** Human-readable size: "{x.y} MB" (one decimal), or "{k} KB" under 1 MB (W14). */
function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Join a capped filename sample with an "and {k} more" tail when truncated. */
function missingClause(names: string[], total: number): string {
  const more = Math.max(0, total - names.length);
  const joined = names.join(", ");
  return more > 0 ? `${joined}, and ${more} more` : joined;
}

type UploadFormValues = { files: FileList | null };

export function AttachmentsCard({
  selectedSetId: _selectedSetId,
  columns,
  rowCount,
  attachments,
  attachmentColumn,
  match,
  onAttachmentsChange,
  onColumnChange,
}: {
  selectedSetId: number;
  columns: string[];
  rowCount: number;
  attachments: UploadedAttachment[];
  attachmentColumn: string | null;
  match: AttachmentMatch | null;
  onAttachmentsChange: (list: UploadedAttachment[]) => void;
  onColumnChange: (column: string) => void;
}) {
  const form = useForm<UploadFormValues>({ defaultValues: { files: null } });

  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  // Per-file field-anchored errors (too-large / duplicate), one line per file.
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  // Destructive Alert for a server/unknown or session-expired failure.
  const [uploadAlert, setUploadAlert] = useState<
    { title: string; body: string } | null
  >(null);

  const selectedFiles = form.watch("files");
  const hasChosenFiles = !!selectedFiles && selectedFiles.length > 0;

  async function onUpload(values: UploadFormValues) {
    setUploadAlert(null);
    const files = values.files ? Array.from(values.files) : [];
    if (files.length === 0) return;

    const errors: string[] = [];
    const valid: File[] = [];

    // Client pre-check with the SHARED schema (no client/server divergence). A
    // rejected file field-anchors its error while the valid ones still upload (W11).
    for (const file of files) {
      const check = uploadAttachmentSchema.safeParse({
        name: file.name,
        size: file.size,
      });
      if (!check.success) {
        const tooLarge = check.error.issues.some((i) => i.path[0] === "size");
        errors.push(
          tooLarge
            ? `'${file.name}' is larger than 10 MB. Attachments can be up to 10 MB each.`
            : `'${file.name}' can't be uploaded.`,
        );
      } else {
        valid.push(file);
      }
    }

    setUploading(true);
    let latest: UploadedAttachment[] | null = null;
    let uploadedCount = 0;

    // ONE call per file — a 10 MB attachment cannot share a request body.
    for (const file of valid) {
      const fd = new FormData();
      fd.set("file", file);
      const res = await uploadAttachment(fd);
      if (res.ok) {
        latest = res.data;
        uploadedCount++;
        continue;
      }
      switch (res.error.kind) {
        case "duplicate_filename":
          errors.push(
            `You've already uploaded a file called '${file.name}'. Remove it first if you want to replace it.`,
          );
          break;
        case "too_large":
          errors.push(
            `'${file.name}' is larger than 10 MB. Attachments can be up to 10 MB each.`,
          );
          break;
        case "unauthenticated":
          setUploadAlert({
            title: "Your session has expired",
            body: "Sign in again to upload attachments.",
          });
          break;
        default:
          setUploadAlert({
            title: "Couldn't upload your files",
            body: "We couldn't upload those files. Try again, and if it keeps failing, refresh the page.",
          });
      }
    }

    setUploading(false);
    setFileErrors(errors);
    form.reset({ files: null });

    if (latest) onAttachmentsChange(latest);
    if (uploadedCount > 0) {
      toast.success(
        `${uploadedCount} ${uploadedCount === 1 ? "file" : "files"} uploaded.`,
      );
    }
  }

  async function onRemove(att: UploadedAttachment) {
    setRemovingId(att.id);
    const res = await deleteAttachment(att.id);
    setRemovingId(null);
    if (res.ok) onAttachmentsChange(res.data);
    // A cross-tenant/absent id is a benign no-op; no toast, no confirmation (W5).
  }

  const columnHelp = attachmentColumn
    ? `We detected ${attachmentColumn} as the attachment column. Change it if that's not right.`
    : "Choose which column holds each row's attachment filename.";

  // The match summary renders ONLY once a column is active, strictly from the
  // server `AttachmentMatch` (never derived from sample rows).
  const showMatch = !!match && !!match.attachmentColumn;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Attachments (optional)</CardTitle>
        <CardDescription className="text-base">
          Attach a different file to each row. Upload the files here, then choose
          the CSV column that holds each row&apos;s filename. Max 10 MB per file,
          15 MB per email.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onUpload)}
            className="flex flex-col gap-6"
          >
            <FormField
              control={form.control}
              name="files"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Files</FormLabel>
                  <FormControl>
                    <Input
                      type="file"
                      multiple
                      disabled={uploading}
                      onChange={(e) => {
                        setFileErrors([]);
                        setUploadAlert(null);
                        field.onChange(e.target.files);
                      }}
                    />
                  </FormControl>
                  {fileErrors.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {fileErrors.map((message, i) => (
                        <p
                          key={i}
                          className="text-sm font-medium text-destructive"
                        >
                          {message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </FormItem>
              )}
            />

            {uploadAlert ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{uploadAlert.title}</AlertTitle>
                <AlertDescription>{uploadAlert.body}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={uploading || !hasChosenFiles}>
                {uploading ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload />
                    Upload files
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>

        {attachments.length > 0 ? (
          <div className="divide-y rounded-lg border">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center gap-2 px-3 py-3">
                <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-sm break-all">{att.filename}</span>
                <span className="text-sm text-muted-foreground">
                  {formatSize(att.size_bytes)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${att.filename}`}
                  disabled={uploading || removingId === att.id}
                  onClick={() => onRemove(att)}
                >
                  {removingId === att.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <X className="size-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="attachment-column">Attachment column</Label>
            <Select
              value={attachmentColumn ?? ""}
              onValueChange={(value) => onColumnChange(value)}
            >
              <SelectTrigger id="attachment-column" className="w-full">
                <SelectValue placeholder="Choose the attachment column" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((col) => (
                  <SelectItem key={col} value={col}>
                    {col}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{columnHelp}</p>
            {!attachmentColumn ? (
              <p className="text-sm text-muted-foreground">
                Pick the attachment column to match these files to your rows.
              </p>
            ) : null}
          </div>
        ) : null}

        {showMatch && match ? (
          <div className="flex flex-col gap-2">
            {match.missingAttachmentCount === 0 &&
            match.oversizeRowCount === 0 ? (
              match.rowsWithAttachment === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>
                    {`No rows in ${match.attachmentColumn} name a file. Every email will send without an attachment.`}
                  </span>
                </div>
              ) : match.rowsWithAttachment >= rowCount ? (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>{`All ${rowCount} rows match an uploaded file.`}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>
                    {`${match.rowsWithAttachment} of ${rowCount} rows include an attachment — the rest will send without one.`}
                  </span>
                </div>
              )
            ) : null}

            {match.missingAttachmentCount > 0 ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Some attachments are missing</AlertTitle>
                <AlertDescription>
                  {`${match.missingAttachmentCount} rows reference files you haven't uploaded: ${missingClause(
                    match.missingAttachmentFilenames,
                    match.missingAttachmentCount,
                  )}. Upload the missing files or fix your CSV — you can't send until every named file is here.`}
                </AlertDescription>
              </Alert>
            ) : null}

            {match.oversizeRowCount > 0 ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Some rows are over the attachment limit</AlertTitle>
                <AlertDescription>
                  {`${match.oversizeRowCount} rows have more than 15 MB of attachments. Emails can carry up to 15 MB of attachments each — use smaller files for those rows.`}
                </AlertDescription>
              </Alert>
            ) : null}

            {match.unreferencedUploadCount > 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="size-4 shrink-0" />
                <span>
                  {`${match.unreferencedUploadCount} uploaded ${
                    match.unreferencedUploadCount === 1 ? "file" : "files"
                  } ${
                    match.unreferencedUploadCount === 1 ? "isn't" : "aren't"
                  } named by any row — ${
                    match.unreferencedUploadCount === 1 ? "it" : "they"
                  } won't be sent.`}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
