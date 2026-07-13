/**
 * fill — generalized {{column}} merge substitution.
 *
 * Lifted and fixed from the CLI's `send-credentials.ts::fill()`, which only
 * replaced two hard-coded tokens ({{email}}, {{password}}) and was applied to
 * the body alone. This module:
 *   - generalizes substitution to ARBITRARY column keys, and
 *   - exposes `fillMessage` which applies fill to BOTH subject and body,
 *     fixing the CLI's "--test subjects are not filled" bug (EDIT-03).
 *
 * PURITY: depends on nothing but the language. No DB, Clerk, or Next imports —
 * this is consumed by Phase 5 (test-send) and Phase 6 (worker) unchanged.
 */

export type Row = Record<string, string>;

export interface MessageTemplate {
  subject: string;
  body: string;
}

// Matches `{{column}}` capturing any non-brace inner content, so column keys
// containing spaces (e.g. `{{First Name}}`), dots, or hyphens are supported.
// Inner whitespace is tolerated: the captured group is trimmed to the column
// key at lookup time (`{{ First Name }}` → `First Name`).
const TOKEN = /\{\{([^{}]+)\}\}/g;

/**
 * Replace every `{{column}}` token in `template` with the matching value from
 * `row`. Documented unmatched-token rule: a token whose key is NOT present in
 * `row` is left intact (pass-through), so a misnamed field is visible in the
 * preview/output rather than silently blanked.
 *
 * Replacement is done via a function callback so row values containing `$`
 * (e.g. "$1,000") are inserted literally and never interpreted as regex
 * replacement specials.
 */
export function fill(template: string, row: Row): string {
  return template.replace(TOKEN, (match, capture: string) => {
    const key = capture.trim();
    return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : match;
  });
}

/**
 * Apply {{column}} substitution to BOTH the subject and the body of a message
 * template for a single recipient row (EDIT-03 — the CLI only filled the body).
 */
export function fillMessage(tpl: MessageTemplate, row: Row): MessageTemplate {
  return {
    subject: fill(tpl.subject, row),
    body: fill(tpl.body, row),
  };
}
