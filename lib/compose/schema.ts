/**
 * lib/compose/schema — the shared zod 4 compose-form guard (EDIT-01 / T-4-SIZE).
 *
 * ONE schema, parsed on both the client (react-hook-form resolver) and the server
 * (the saveTemplate action-core), so subject/body validation can never diverge —
 * the same idiom as `lib/csv/schema.ts` and `lib/smtp/schema.ts`.
 *
 * EDIT-01: subject and body are both required; the min() messages are the exact
 *          sentence-case copy from 04-UI-SPEC.md (lines 136-137).
 * T-4-SIZE: subject is capped at 998 chars (RFC 5322 single-line limit, RESEARCH
 *           A7) and body at 50000 chars so oversized input rejects with a clear
 *           message BEFORE any persistence.
 *
 * zod 4 idioms only (Pitfall 7): exported schema object + `export type X =
 * z.infer<typeof schema>`, top-level validators only.
 */

import { z } from "zod";

/**
 * The compose form: a plain-text subject + body. `.trim()` first so a
 * whitespace-only value fails the `min(1)` emptiness guard rather than sneaking
 * through as "non-empty".
 */
export const composeFormSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "Add a subject before saving.")
    .max(998, "Keep the subject under 998 characters."),
  body: z
    .string()
    .trim()
    .min(1, "Write a message before saving.")
    .max(50000, "This message is too long."),
});

export type ComposeFormValues = z.infer<typeof composeFormSchema>;
