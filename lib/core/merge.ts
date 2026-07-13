/**
 * merge — the pure merge-gap engine (PREV-02 / PREV-03).
 *
 * `extractTokens` lists the `{{column}}` keys used by a template; `analyzeMerge`
 * classifies each token against a single row + the CSV's column set as either
 *   - `empty`   (the key IS a column but the row's value is blank), or
 *   - `unknown` (the key is NOT a column — an authoring typo).
 * A token whose key is a column with a non-blank value is reported in NEITHER
 * array (it is "present"). This powers the per-row empty-value highlight and the
 * client-side validation-report aggregates in the preview stepper.
 *
 * PURITY: depends on nothing but the language (no DB, Clerk, or Next module
 * dependencies), so it is browser-safe and reusable by the client preview. The
 * TOKEN regex is kept identical to `lib/core/fill.ts` on purpose — the two files
 * stay independently pure and do NOT reference each other.
 */

export interface MergeAnalysis {
  empty: string[];
  unknown: string[];
}

// Matches `{{column}}` with optional inner whitespace, e.g. `{{name}}` or
// `{{ name }}`. The captured group is the trimmed-around column key. Kept
// identical to lib/core/fill.ts (deliberately not shared — both stay pure).
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Return the `{{column}}` token keys used in `template`, in first-seen order and
 * de-duplicated. A token-free or empty string yields `[]`. Inner brace
 * whitespace is tolerated (`{{ name }}` → `name`).
 */
export function extractTokens(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    seen.add(m[1]);
  }
  return [...seen];
}

/**
 * Classify each `{{token}}` in `template` for a single `row` against the CSV's
 * `columns`. A key that is not a column is `unknown` (the unknown check wins, so
 * a missing key is never also reported `empty`); a key that is a column but
 * whose value is blank (or whitespace-only) is `empty`; a column with a
 * non-blank value appears in neither array.
 */
export function analyzeMerge(
  template: string,
  row: Record<string, string>,
  columns: string[],
): MergeAnalysis {
  const columnSet = new Set(columns);
  const empty: string[] = [];
  const unknown: string[] = [];
  for (const key of extractTokens(template)) {
    if (!columnSet.has(key)) {
      unknown.push(key); // authoring typo — unknown wins over empty
    } else if ((row[key] ?? "").trim() === "") {
      empty.push(key); // column exists but this row's value is blank
    }
  }
  return { empty, unknown };
}
