"use server";

/**
 * lib/campaign/actions — the Server Action behind the whole-batch test-send
 * (TEST-01 / AUTH-02 / SMTP-04). This is the seam that ties Clerk identity to the
 * chunked test-send core and defines the typed result contract the campaign UI
 * consumes:
 *
 *   sendTestBatchChunk — { recipientSetId, templateId, testAddress, offset } →
 *     a userId-scoped, bounded chunk of personalized sends redirected to the one
 *     test address, plus a cursor ({nextOffset, done, total}) the client loops on.
 *
 * SECURITY:
 *  - T-5-IDOR / T-5-ENDPOINT / AUTH-02: every runtime export of a "use server"
 *    module is a client-invocable endpoint, so this file exports ONLY the action
 *    below — it re-derives `userId` server-side via `auth()` and passes it to the
 *    core; a client-supplied id is never trusted. The userId-accepting seam lives
 *    in ./actions-core.ts (no "use server"), where it is an import, not an
 *    endpoint.
 *  - T-5-CRED / SMTP-04 / D-06: no action return ever carries the password or a
 *    raw Error — a `raw` is always a message STRING.
 */

import {
  sendTestBatchChunkCore,
  type TestSendInput,
  type TestSendResult,
} from "./actions-core";
import { TEST_SEND_DELAY_MS } from "./schema";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the campaign UI imports its contract from here.
export type { ActionError, TestSendData, TestSendResult } from "./actions-core";

/**
 * sendTestBatchChunk (TEST-01): auth → delegate. Rejects unauthenticated callers
 * before any work, then delegates to `sendTestBatchChunkCore` with the
 * server-derived userId. Passes NO transportOverride — the wrapper always builds
 * the real transport — and injects the production inter-send throttle
 * (`TEST_SEND_DELAY_MS`) as the composition root, so every real send is paced.
 */
export async function sendTestBatchChunk(
  input: TestSendInput,
): Promise<TestSendResult> {
  // Lazy import: `@clerk/nextjs/server` resolves its `auth` export only under the
  // Next server runtime, so importing it lazily keeps this module loadable under
  // the plain test runner.
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return sendTestBatchChunkCore(userId, input, undefined, TEST_SEND_DELAY_MS);
}
