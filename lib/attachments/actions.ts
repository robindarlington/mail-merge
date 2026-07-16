"use server";

/**
 * lib/attachments/actions — the Server Actions behind the compose-page attachment
 * upload flow (ATCH-01 / AUTH-02). This is the seam that ties Clerk identity to the
 * userId-accepting cores in ./actions-core.ts and the userId-scoped attachments DAL.
 *
 * SECURITY:
 *  - T-07-04 / AUTH-02: every runtime export of a server-action module is a
 *    client-invocable endpoint, so this file exports ONLY the actions below — each
 *    re-derives `userId` server-side via `auth()` and passes it to the core; a
 *    client-supplied id is never trusted. The userId-accepting seams live in
 *    ./actions-core.ts (no server-action directive), where they are imports, not
 *    endpoints.
 *  - T-07-07: the lazy Clerk `auth()` gate returns `unauthenticated` before any
 *    core work runs.
 *  - T-07-CRED: no action return ever carries file bytes or a raw Error — a `raw`
 *    is always a message STRING.
 */

import {
  uploadAttachmentCore,
  listAttachmentsCore,
  deleteAttachmentCore,
  confirmAttachmentColumnCore,
  type AttachmentListResult,
  type ConfirmColumnResult,
} from "./actions-core";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the compose UI (Plan 04/05) imports its contract from here.
export type {
  ActionError,
  AttachmentListResult,
  ConfirmColumnResult,
} from "./actions-core";

/**
 * uploadAttachment: auth → guard/write/insert. Rejects unauthenticated callers
 * before any work. One file per call (the 10 MB body cannot share a request).
 */
export async function uploadAttachment(
  formData: FormData,
): Promise<AttachmentListResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return uploadAttachmentCore(userId, formData);
}

/** listAttachments: auth → the caller's pending uploads. */
export async function listAttachments(): Promise<AttachmentListResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return listAttachmentsCore(userId);
}

/** deleteAttachment: auth → owner-scoped delete → refreshed list. */
export async function deleteAttachment(
  id: number,
): Promise<AttachmentListResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return deleteAttachmentCore(userId, id);
}

/** confirmAttachmentColumn: auth → persist the chosen column on the owner's set. */
export async function confirmAttachmentColumn(
  setId: number,
  column: string,
): Promise<ConfirmColumnResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return confirmAttachmentColumnCore(userId, setId, column);
}
