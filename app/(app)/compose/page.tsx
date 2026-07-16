import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import {
  listRecipientSetsForUser,
  listSmtpConfigsForUser,
  listPendingAttachmentsForUser,
  toSmtpConfigDto,
} from "@/lib/data";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ComposeEditor } from "@/components/compose/compose-editor";

/**
 * /compose — the first user-visible slice of Phase 4 (EDIT-01/02/04). This RSC
 * mirrors app/(app)/recipients/page.tsx: it re-derives the Clerk `userId`
 * server-side and lists ONLY that user's recipient sets via the userId-scoped DAL
 * (listRecipientSetsForUser) — an unauthenticated load yields an empty list,
 * never another tenant's sets (T-4-IDOR / AUTH-02).
 *
 * With no recipient lists yet, a dominant empty-state Card gates the editor and
 * points the user at /lists (the single accent CTA in that state). Once at
 * least one list exists, the client <ComposeEditor> renders; each set's columns
 * (columns_json) feed the merge-field autocomplete with no extra round-trip.
 */
export default async function ComposePage() {
  const { userId } = await auth();
  const sets = userId ? await listRecipientSetsForUser(userId) : [];

  // Send-card server picker (06.1 multi-server): list the user's verified servers
  // and project each through the redacted DTO. Only the DTO (id/label/is_default/
  // sender identity — NEVER the encrypted SMTP triple/password) crosses to the
  // client (T-061-11 / SMTP-04). A verified server is one with a non-null
  // verified_at; soft-deleted rows are already excluded by the DAL.
  const rows = userId ? await listSmtpConfigsForUser(userId) : [];
  const configs = rows
    .filter((row) => row.verified_at !== null)
    .map(toSmtpConfigDto);
  const user = userId ? await currentUser() : null;
  const defaultTestEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  // The user's PENDING uploads (campaign_id IS NULL) prefill the attachments card
  // so a refresh mid-compose keeps the already-uploaded files (ATCH-01). Scoped to
  // userId by the DAL — never another tenant's uploads.
  const initialAttachments = userId
    ? await listPendingAttachmentsForUser(userId)
    : [];

  const editorSets = sets.map((set) => ({
    id: set.id,
    filename: set.filename,
    label: set.label,
    row_count: set.row_count,
    columns_json: set.columns_json,
    attachment_column: set.attachment_column,
  }));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-[1.2]">Compose</h1>

      {editorSets.length === 0 ? (
        <Card className="py-12">
          <CardHeader className="items-center text-center">
            <CardTitle className="text-xl">
              Upload a recipient list to start composing
            </CardTitle>
            <CardDescription className="text-base">
              Compose pulls its merge fields from a saved recipient list. Upload a
              CSV first, then come back to write your email.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button asChild>
              <Link href="/lists">Go to lists</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ComposeEditor
          sets={editorSets}
          configs={configs}
          defaultTestEmail={defaultTestEmail}
          initialAttachments={initialAttachments}
        />
      )}
    </div>
  );
}
