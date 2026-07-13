"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { analyzeMerge, fillMessage } from "@/lib/core";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * PreviewStepper — the live merged preview + pre-send validation report
 * (PREV-01/02/03 + EDIT-03). Given the rows the SERVER fetched once
 * (`previewCampaign`), it steps through them CLIENT-side, rendering each row's
 * merged subject/body via `fillMessage` and its "To:" line via the
 * SERVER-resolved `emailColumn` prop (never a client re-detection).
 *
 * Server vs client authority (04-PATTERNS.md — anti-divergence / T-4-DIVERGE):
 *   - `invalidEmailCount` + `emailColumn` are TEMPLATE-INDEPENDENT and come from
 *     the previewCampaign result as PROPS — this component never recomputes the
 *     invalid-email count nor re-detects the email column.
 *   - `unknownTokens` + `rowsWithEmptyValues` are TEMPLATE-DEPENDENT and are
 *     computed HERE, client-side, reactively over ALL fetched rows via
 *     `analyzeMerge`, so a typed `{{typo}}` surfaces immediately (no refetch)
 *     and the report can never go stale against the composed template.
 *
 * The merged output renders as escaped JSX text inside `whitespace-pre-wrap` —
 * a CSV cell value is NEVER injected as HTML (stored-XSS defense) and is never
 * logged.
 */

type PreviewStepperProps = {
  subject: string;
  body: string;
  columns: string[];
  rows: Record<string, string>[];
  totalRows: number;
  /** Server-authoritative invalid-email count (template-INDEPENDENT). */
  invalidEmailCount: number;
  /** Server-resolved To: column (template-INDEPENDENT) — null renders no To: line. */
  emailColumn: string | null;
  loading: boolean;
};

/** Join field names for the neutral per-row empty-value note. */
function joinFields(fields: string[]): string {
  return fields.join(", ");
}

/** Render `{{a}}, {{b}}` for the unknown-token warning copy. */
function joinTokens(tokens: string[]): string {
  return tokens.map((t) => `{{${t}}}`).join(", ");
}

export function PreviewStepper({
  subject,
  body,
  columns,
  rows,
  totalRows,
  invalidEmailCount,
  emailColumn,
  loading,
}: PreviewStepperProps) {
  const [step, setStep] = useState(0);

  // Reset to the first row whenever a new list's rows arrive.
  useEffect(() => {
    setStep(0);
  }, [rows]);

  const total = rows.length;
  // Clamped current index — always in range while rows is non-empty (the idle
  // guard below returns before this is used when there are no rows).
  const i = total > 0 ? Math.min(step, total - 1) : 0;

  // Template-DEPENDENT report aggregates, computed client-side over ALL rows.
  // Deferred subject/body keep typing responsive on large (~1,000+ row) lists;
  // correctness is always over the FULL row set (never a sample).
  const deferredSubject = useDeferredValue(subject);
  const deferredBody = useDeferredValue(body);
  const { unknownTokens, rowsWithEmptyValues } = useMemo(() => {
    const template = deferredSubject + "\n" + deferredBody;
    // Unknown tokens are template-level (a key NOT in `columns`), independent of
    // row values — analyze against the first row (or {} when there are none).
    const unknown = analyzeMerge(template, rows[0] ?? {}, columns).unknown;
    const missing = rows.filter(
      (row) => analyzeMerge(template, row, columns).empty.length > 0,
    ).length;
    return { unknownTokens: unknown, rowsWithEmptyValues: missing };
  }, [deferredSubject, deferredBody, columns, rows]);

  // ---- LOADING ----
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Preview</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
          <Separator />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  // ---- IDLE (no list selected / rows not loaded, or empty template) ----
  const templateEmpty = subject.trim() === "" && body.trim() === "";
  if (total === 0 || templateEmpty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Choose a recipient list and write your message to see a preview.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ---- ACTIVE PREVIEW ----
  const merged = fillMessage({ subject, body }, rows[i]);
  const gaps = analyzeMerge(subject + "\n" + body, rows[i], columns);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Preview</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {`Recipient ${i + 1} of ${total}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={i === 0}
                onClick={() => setStep(i - 1)}
              >
                <ChevronLeft />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={i === total - 1}
                onClick={() => setStep(i + 1)}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            {emailColumn ? (
              <span>{`To: ${rows[i][emailColumn] ?? ""}`}</span>
            ) : null}
            <span>{`Subject: ${merged.subject}`}</span>
          </div>

          <Separator />

          <div className="whitespace-pre-wrap text-base">{merged.body}</div>

          {gaps.empty.length > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="size-4 shrink-0" />
              <span>
                {`This recipient is missing a value for ${joinFields(
                  gaps.empty,
                )}. That spot will be blank in their email.`}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Validation report</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {unknownTokens.length > 0 ? (
            <div className="flex items-start gap-2 text-sm text-foreground">
              <AlertTriangle className="size-4 shrink-0" />
              <span>
                {`Your template uses ${joinTokens(unknownTokens)}, which ${
                  unknownTokens.length === 1 ? "isn't" : "aren't"
                } a column in this recipient list. It will appear literally in every email — remove it or pick a real field.`}
              </span>
            </div>
          ) : null}

          {invalidEmailCount > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="size-4 shrink-0" />
              <span>
                {`${invalidEmailCount} of ${totalRows} rows don't have a valid email address. They'll be skipped when you send.`}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>{`All ${totalRows} rows have a valid email address.`}</span>
            </div>
          )}

          {rowsWithEmptyValues > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="size-4 shrink-0" />
              <span>
                {`${rowsWithEmptyValues} of ${totalRows} rows are missing a value for at least one merge field. Those spots will be blank.`}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>
                Every row has a value for each merge field in your template.
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
