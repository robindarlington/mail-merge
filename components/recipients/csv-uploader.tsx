"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2, Upload } from "lucide-react";

import { parseUploadedCsv, saveRecipientSet } from "@/lib/csv/actions";
import type { ParseSummary, ActionError } from "@/lib/csv";
import { uploadFileSchema } from "@/lib/csv/schema";
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
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * CsvUploader — the client shell for the whole upload → review → save slice
 * (CSV-01/03/04/05). It mirrors the SMTP wizard's react-hook-form + zod seam and
 * step-test-send's action-call + pending + typed-failure pattern.
 *
 * Two in-page steps (03-UI-SPEC U2):
 *   1. UPLOAD — an `Input type="file"` guarded by the SHARED `uploadFileSchema`,
 *      submitted to `parseUploadedCsv`. Field-anchored blocking errors
 *      (wrong_type / too_large / too_many_rows) render on the file input; server
 *      parse_error / empty render as a destructive Alert.
 *   2. REVIEW — a `Select` prefilled to the auto-detected email column with the
 *      per-column invalid count. CSV-04: the invalid/valid line reads the
 *      server-computed `parseData.invalidCounts[emailColumn]` on every override —
 *      it NEVER re-parses in the browser and NEVER derives the count from the 5
 *      sample rows (the sample table is a cosmetic aid only). `saveRecipientSet`
 *      persists the CONFIRMED column; its Save button disables while in flight so
 *      a double click can't insert twice (T-3-DBLSUBMIT).
 */

const SAMPLE_ROW_LIMIT = 5;

/** Where a parse failure surfaces + the exact UI-SPEC copy for it. */
type ParseFailure = { target: "file" | "alert"; message: string };

/**
 * Map every ActionError kind to its UI-SPEC copy and its surface: the three
 * blocking file-shape errors anchor to the file input; everything else is a
 * destructive Alert. The switch is exhaustive over the closed union.
 */
function parseFailureFor(error: ActionError): ParseFailure {
  switch (error.kind) {
    case "wrong_type":
      return {
        target: "file",
        message: "That file isn't a CSV. Upload a file that ends in .csv.",
      };
    case "too_large":
      return {
        target: "file",
        message:
          "That file is larger than 4 MB. Split it into smaller lists and upload again.",
      };
    case "too_many_rows":
      return {
        target: "file",
        message:
          "That file has more than 5,000 rows. Split it into smaller lists and upload again.",
      };
    case "parse_error":
      return {
        target: "alert",
        message:
          "We couldn't read that CSV cleanly. Check it opens correctly in a spreadsheet, then upload again.",
      };
    case "empty":
      return {
        target: "alert",
        message:
          "That file is empty or has no header row. Add a header row and upload again.",
      };
    case "unauthenticated":
      return {
        target: "alert",
        message: "Your session has expired. Sign in again and re-upload the file.",
      };
    case "validation":
      return {
        target: "file",
        message: "That file isn't a CSV. Upload a file that ends in .csv.",
      };
    // `in_use` / `not_found` belong to the list-DELETE action (deleteList); the
    // upload/parse/save flow here never produces them, but the shared ActionError
    // union includes them, so the exhaustive switch handles them with a neutral
    // retry message rather than falling through.
    case "in_use":
    case "not_found":
    case "unknown":
      return {
        target: "alert",
        message:
          "We couldn't read that CSV cleanly. Check it opens correctly in a spreadsheet, then upload again.",
      };
  }
}

/**
 * Minimal, quote-aware CSV reader for the COSMETIC sample preview only. It reads
 * the chosen File's text on the client so papaparse stays off the browser bundle
 * (the authoritative counts come from the server's `invalidCounts`, never here).
 * Bounded to `header + limit` records.
 */
function readSampleRecords(text: string, maxRecords: number): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      if (records.length >= maxRecords) return records;
    } else {
      field += c;
    }
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

type ReviewState = {
  data: ParseSummary;
  file: File;
  sampleRows: string[][];
};

type UploadFormValues = { file: File | null };

export function CsvUploader() {
  const router = useRouter();

  const form = useForm<UploadFormValues>({
    defaultValues: { file: null },
  });

  // Upload-step state.
  const [parsing, setParsing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Review-step state (present once a parse succeeds).
  const [review, setReview] = useState<ReviewState | null>(null);
  const [emailColumn, setEmailColumn] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function onUpload(values: UploadFormValues) {
    setUploadError(null);
    const file = values.file;
    if (!file) {
      form.setError("file", { message: "Choose a CSV file to upload." });
      return;
    }

    // Client-side pre-check with the SAME schema the server uses (no divergence).
    const check = uploadFileSchema.safeParse({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!check.success) {
      form.setError("file", {
        message: check.error.issues[0]?.message ?? "That file isn't a CSV.",
      });
      return;
    }

    setParsing(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await parseUploadedCsv(fd);

    if (!res.ok) {
      setParsing(false);
      const failure = parseFailureFor(res.error);
      if (failure.target === "file") {
        form.setError("file", { message: failure.message });
      } else {
        setUploadError(failure.message);
      }
      return;
    }

    // Read up to 5 sample rows from the chosen file for the cosmetic preview.
    let sampleRows: string[][] = [];
    try {
      const text = await file.text();
      const records = readSampleRecords(text, SAMPLE_ROW_LIMIT + 1);
      sampleRows = records.slice(1); // drop the header record; columns come from the server
    } catch {
      sampleRows = [];
    }

    setParsing(false);
    setReview({ data: res.data, file, sampleRows });
    setEmailColumn(res.data.detectedEmailColumn ?? "");
  }

  function resetToUpload() {
    setReview(null);
    setEmailColumn("");
    setSaveError(null);
    setUploadError(null);
    form.reset({ file: null });
  }

  async function onSave() {
    if (!review || !emailColumn) return;
    setSaving(true);
    setSaveError(null);

    const fd = new FormData();
    fd.set("file", review.file);
    fd.set("emailColumn", emailColumn);
    const res = await saveRecipientSet(fd);
    setSaving(false);

    if (res.ok) {
      toast.success(
        `Recipient list saved — ${res.data.rowCount} recipients from ${res.data.filename}.`,
      );
      resetToUpload();
      router.refresh();
      return;
    }

    setSaveError(
      "We couldn't save that recipient list. Try again, and if it keeps failing, re-upload the file.",
    );
  }

  // ---- REVIEW STEP ----
  if (review) {
    const { data, sampleRows } = review;
    const invalidForColumn = emailColumn
      ? (data.invalidCounts[emailColumn] ?? 0)
      : null;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Review recipients</CardTitle>
          <CardDescription className="text-base">
            Found {data.rowCount} rows and {data.columns.length} columns in{" "}
            {review.file.name}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email-column">Email column</Label>
            <Select value={emailColumn} onValueChange={setEmailColumn}>
              <SelectTrigger id="email-column" className="w-full">
                <SelectValue placeholder="Choose the email column" />
              </SelectTrigger>
              <SelectContent>
                {data.columns.map((col) => (
                  <SelectItem key={col} value={col}>
                    {col}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {data.detectedEmailColumn
                ? `We detected ${data.detectedEmailColumn} as the email column. Change it if that's not right.`
                : "We couldn't detect the email column automatically. Choose which column holds the email addresses."}
            </p>
          </div>

          {invalidForColumn !== null ? (
            invalidForColumn > 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="size-4 shrink-0" />
                <span>
                  {`${invalidForColumn} of ${data.rowCount} rows don't have a valid email address. They'll be skipped when you send.`}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" />
                <span>All {data.rowCount} rows have a valid email address.</span>
              </div>
            )
          ) : null}

          {sampleRows.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    {data.columns.map((col) => (
                      <TableHead key={col}>{col}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sampleRows.map((row, r) => (
                    <TableRow key={r}>
                      {data.columns.map((col, c) => (
                        <TableCell key={col}>{row[c] ?? ""}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
                <TableCaption>
                  Showing the first {sampleRows.length} rows.
                </TableCaption>
              </Table>
            </div>
          ) : null}

          {saveError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Couldn&apos;t save recipient list</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={resetToUpload}
            >
              Choose a different file
            </Button>
            <Button
              type="button"
              disabled={saving || !emailColumn}
              onClick={onSave}
            >
              {saving ? (
                <>
                  <Loader2 className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <CheckCircle2 />
                  Save recipient list
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- UPLOAD STEP ----
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Upload a CSV</CardTitle>
        <CardDescription className="text-base">
          Your file needs a header row and a column of email addresses. Max 4 MB,
          up to 5,000 rows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onUpload)}
            className="flex flex-col gap-6"
          >
            <FormField
              control={form.control}
              name="file"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>CSV file</FormLabel>
                  <FormControl>
                    <Input
                      type="file"
                      accept=".csv,text/csv"
                      disabled={parsing}
                      onChange={(e) => {
                        setUploadError(null);
                        form.clearErrors("file");
                        field.onChange(e.target.files?.[0] ?? null);
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {uploadError ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>We couldn&apos;t read that file</AlertTitle>
                <AlertDescription>{uploadError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={parsing || !form.watch("file")}>
                {parsing ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Reading your file…
                  </>
                ) : (
                  <>
                    <Upload />
                    Upload CSV
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
