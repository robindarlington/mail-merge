/**
 * lib/attachments/schema — shared zod guards + centralized size limits for
 * per-row attachments (ATCH-01 / T-07-03).
 *
 * ONE schema, parsed on both the client (react-hook-form resolver) and the
 * server (the upload action), so file-size validation can never diverge — the
 * same idiom as `lib/csv/schema.ts`.
 *
 * The two byte limits are centralized here (CONTEXT: "centralized so Phase 8/ops
 * can tune via env later") and read from an env var with a literal fallback,
 * mirroring `lib/csv/storage.ts`'s `process.env.UPLOADS_PATH ?? ...` idiom:
 *   - MAX_ATTACHMENT_BYTES — per-file cap (10 MB).
 *   - MAX_MESSAGE_BYTES     — per-message cap (15 MB); the confirm gate sums a
 *                             row's attachment sizes against this downstream.
 *
 * UI-SPEC W13: any file TYPE is attachable — there is NO extension/mime gate,
 * so the schema validates the `{ name, size }` pair a Web `File` exposes only.
 *
 * zod 4 idioms only: exported schema object + `export type X = z.infer<...>`,
 * sentence-case UI messages.
 */

import { z } from "zod";

/** Per-file upload cap (T-07-03). Env-tunable; defaults to 10 MB. */
export const MAX_ATTACHMENT_BYTES =
  Number(process.env.MAX_ATTACHMENT_BYTES) || 10 * 1024 * 1024;

/** Per-message cap — summed across a row's attachments downstream. Defaults to 15 MB. */
export const MAX_MESSAGE_BYTES =
  Number(process.env.MAX_MESSAGE_BYTES) || 15 * 1024 * 1024;

/**
 * Per-user upload quota (WR-02): a cap on how MANY pending/draft uploads and how
 * many total bytes one tenant can hold on the shared UPLOADS_PATH volume before an
 * upload is refused. Without this, an authenticated tenant can loop uploads and
 * exhaust the disk that holds every tenant's files. Env-tunable like the size caps.
 *   - MAX_PENDING_ATTACHMENTS       — max count of pending/draft uploads (100).
 *   - MAX_PENDING_ATTACHMENT_BYTES  — max total pending/draft bytes (200 MB).
 */
export const MAX_PENDING_ATTACHMENTS =
  Number(process.env.MAX_PENDING_ATTACHMENTS) || 100;

export const MAX_PENDING_ATTACHMENT_BYTES =
  Number(process.env.MAX_PENDING_ATTACHMENT_BYTES) || 200 * 1024 * 1024;

/**
 * File-metadata guard: a non-empty name + a size within the per-file cap. No
 * extension/mime restriction (W13 — any file type is attachable). Validates the
 * `{ name, size }` pair a real Server-Action `File` (or a client descriptor)
 * exposes, so the client resolver and the server action share one source of truth.
 */
export const uploadAttachmentSchema = z.object({
  // Normalize at the trust boundary (WR-06): a `File.name` is fully
  // attacker-controlled (a scripted FormData can carry CR/LF, tabs, or NUL and
  // other control bytes) and the stored original name is forwarded verbatim into
  // nodemailer's `Content-Disposition`/`name` MIME header parameter. Strip control
  // characters here so neither header injection nor a corrupt display name can ride
  // an upload — defense-in-depth that no longer relies on nodemailer's own folding.
  name: z
    .string()
    .min(1, "That file has no name.")
    .transform((s) => s.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim())
    .pipe(z.string().min(1, "That file has no name.")),
  size: z
    .number()
    .max(
      MAX_ATTACHMENT_BYTES,
      "That file is larger than 10 MB. Attachments can be up to 10 MB each.",
    ),
});

export type UploadAttachment = z.infer<typeof uploadAttachmentSchema>;
