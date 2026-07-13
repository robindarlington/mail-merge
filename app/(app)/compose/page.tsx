import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

import { listRecipientSetsForUser } from "@/lib/data";
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
 * points the user at /recipients (the single accent CTA in that state). Once at
 * least one list exists, the client <ComposeEditor> renders; each set's columns
 * (columns_json) feed the merge-field autocomplete with no extra round-trip.
 */
export default async function ComposePage() {
  const { userId } = await auth();
  const sets = userId ? await listRecipientSetsForUser(userId) : [];

  const editorSets = sets.map((set) => ({
    id: set.id,
    filename: set.filename,
    row_count: set.row_count,
    columns_json: set.columns_json,
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
              <Link href="/recipients">Go to recipients</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ComposeEditor sets={editorSets} />
      )}
    </div>
  );
}
