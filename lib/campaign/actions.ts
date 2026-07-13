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
  prepareCampaignCore,
  buildConfirmSummaryCore,
  enqueueCampaignCore,
  type TestSendInput,
  type TestSendResult,
  type PrepareInput,
  type PrepareResult,
  type ConfirmInput,
  type SummaryResult,
  type EnqueueResult,
} from "./actions-core";
import { TEST_SEND_DELAY_MS } from "./schema";

// Type-only re-exports are erased at compile time, so they are NOT registered as
// server actions — the campaign UI imports its contract from here.
export type {
  ActionError,
  TestSendData,
  TestSendResult,
  ConfirmSummary,
  PrepareResult,
  SummaryResult,
  EnqueueResult,
} from "./actions-core";

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

/**
 * prepareCampaign (TEST-02/A1/U7): auth → delegate. Creates the draft campaign at
 * the "review and send" moment from the caller's selected recipient set + template
 * + saved SMTP config. Returns `{ campaignId }` the client then passes (and ONLY
 * that) to buildConfirmSummary + enqueueCampaign.
 */
export async function prepareCampaign(
  input: PrepareInput,
): Promise<PrepareResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return prepareCampaignCore(userId, input);
}

/**
 * buildConfirmSummary (TEST-02): auth → delegate. Returns the server-authoritative
 * review payload the confirm modal renders — every aggregate recomputed server-side
 * from the campaign's own FKs. The client passes ONLY a campaignId.
 */
export async function buildConfirmSummary(
  input: ConfirmInput,
): Promise<SummaryResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return buildConfirmSummaryCore(userId, input);
}

/**
 * enqueueCampaign (TEST-03): auth → delegate. Performs the atomic draft→queued
 * transition; a second confirm returns the benign `already_queued`. NOTE this
 * client-facing action name is DISTINCT from the DAL's `enqueueCampaign` (imported
 * into ./actions-core as `enqueueCampaignDal`); there is no shadowing here — this
 * file delegates to `enqueueCampaignCore`.
 */
export async function enqueueCampaign(
  input: ConfirmInput,
): Promise<EnqueueResult> {
  const { auth } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) return { ok: false, error: { kind: "unauthenticated" } };
  return enqueueCampaignCore(userId, input);
}
