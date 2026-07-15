/**
 * lib/csv/schema — the shared zod 4 upload guards (CSV-01 / T-3-DOS).
 *
 * ONE schema, parsed on both the client (react-hook-form resolver) and the
 * server (the upload action), so file-type/size validation can never diverge —
 * the same idiom as `lib/smtp/schema.ts`.
 *
 * CSV-01: only `.csv` files (by extension AND `text/csv`/`application/vnd.ms-excel`
 *         mime) are accepted.
 * T-3-DOS: `MAX_UPLOAD_BYTES` (4 MB) is enforced here so oversized files reject
 *          with a clear message BEFORE any parse/write. `MAX_ROWS` is published
 *          here for the row-cap check enforced downstream (03-03).
 *
 * zod 4 idioms only (Pitfall 7): exported schema object + `export type X =
 * z.infer<typeof schema>`, sentence-case UI-SPEC messages.
 */

import { z } from "zod";

/** Reject uploads larger than this (kept in step with the Server Action bodySizeLimit). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Medium-scale / DoS row cap, enforced against the parsed row count downstream (03-03). */
export const MAX_ROWS = 5000;

/** Accepted CSV mime types — real browsers/OSes disagree on the CSV type. */
const CSV_MIME_TYPES = ["text/csv", "application/vnd.ms-excel"];

/**
 * File-metadata guard: a `.csv` extension + a CSV mime + size within the cap.
 * Validates the `{ name, type, size }` triple that a Web `File` exposes, so it
 * works on both a real Server-Action `File` and a plain client descriptor.
 * UI-SPEC error messages (03-UI-SPEC.md lines 118-119).
 */
export const uploadFileSchema = z.object({
  name: z
    .string()
    .refine((n) => n.trim().toLowerCase().endsWith(".csv"), {
      message: "That file isn't a CSV. Upload a file that ends in .csv.",
    }),
  type: z.string().refine((t) => CSV_MIME_TYPES.includes(t), {
    message: "That file isn't a CSV. Upload a file that ends in .csv.",
  }),
  size: z
    .number()
    .max(
      MAX_UPLOAD_BYTES,
      "That file is larger than 4 MB. Split it into smaller lists and upload again.",
    ),
});

export type UploadFile = z.infer<typeof uploadFileSchema>;

/**
 * The confirm-column form: the user must pick which column holds the email
 * address (CSV-03 requires human confirmation of the detected default).
 */
export const confirmColumnSchema = z.object({
  emailColumn: z.string().min(1, "Choose the email column"),
});

export type ConfirmColumnValues = z.infer<typeof confirmColumnSchema>;

/**
 * The rename-list form: a required, user-facing display name for a saved list
 * (r8d). Trimmed, non-empty, capped at 60 chars — mirrors smtpFormSchema.label so
 * the client resolver and the server action can never diverge (T-r8d-02).
 */
export const renameListSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Give this list a name.")
    .max(60, "Keep the name under 60 characters."),
});

export type RenameListValues = z.infer<typeof renameListSchema>;
