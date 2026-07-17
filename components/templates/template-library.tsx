import Link from "next/link";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TemplateDelete } from "@/components/templates/template-delete";

/**
 * TemplateLibrary — the per-list saved-template browse + delete surface (tpl). A
 * presentational RSC-friendly component (no client hooks of its own): it renders
 * ONLY the templates its parent RSC already resolved via
 * listTemplatesForRecipientSet, so the owner + list scope (and the D1 exclusion of
 * NULL-scoped legacy rows) is enforced upstream at the data layer.
 *
 * Each row shows the template's subject (truncated) + a relative save date and a
 * <TemplateDelete> confirm affordance. Every cell renders as escaped JSX text only
 * — never dangerouslySetInnerHTML — so attacker-influenced subject content can't
 * inject markup (T-tpl-XSS). Empty state is a muted prompt pointing at compose.
 */

/** Human-friendly relative date from a unixepoch-seconds timestamp (static, RSC-safe). */
function formatRelativeDate(unixSeconds: number): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diffSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === "second") {
      return rtf.format(Math.round(diffSeconds / secs), unit);
    }
  }
  return "just now";
}

type LibraryTemplate = {
  id: number;
  subject: string;
  body: string;
  created_at: number;
};

export function TemplateLibrary({
  templates,
}: {
  templates: LibraryTemplate[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Saved templates</CardTitle>
      </CardHeader>
      <CardContent>
        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved templates for this list yet — compose an email and Save to add
            one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                {/* One-click open (tdl): the subject is a deep link to compose with
                    this template preselected. The subject renders as escaped JSX text
                    only — never dangerouslySetInnerHTML — so attacker-influenced
                    subject content can't inject markup (T-tdl-XSS). The TemplateDelete
                    control stays OUTSIDE the link so a delete click never navigates. */}
                <Link
                  href={`/compose?template=${template.id}`}
                  className="group flex min-w-0 flex-col rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-medium group-hover:underline">
                    {template.subject}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Saved {formatRelativeDate(template.created_at)}
                  </span>
                </Link>
                <TemplateDelete id={template.id} subject={template.subject} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
