/**
 * lib/campaign/schema — the shared zod 4 validators + tuning constants for the
 * test-send / confirmation-gate subsystem (TEST-01, Phase 5).
 *
 * ONE set of validators, parsed on both the client and the server (the
 * campaign action-core), so id / test-address validation can never diverge — the
 * same idiom as `lib/compose/schema.ts` and `lib/smtp/schema.ts`.
 *
 * zod 4 idioms only (Pitfall 7): top-level exported validators + the `z.email()`
 * form (not the removed zod-3 chained `.string().email()`), and
 * `z.coerce.number().int()` for the FormData string → number coercion.
 *
 * CHUNK-SIZE RATIONALE (decision A2/U2 + RESEARCH Pitfall 1): the whole-batch
 * test-send is deliberately UNCAPPED (whole-batch CLI --test parity), but a single
 * synchronous request cannot send an arbitrarily large CSV under a self-hosted
 * Coolify/Traefik reverse-proxy read timeout (~60s). So the batch is split into
 * bounded client-driven chunks. `TEST_SEND_CHUNK_SIZE = 10` keeps the worst-case
 * wall time of one request — ~10 sends + 9×`TEST_SEND_DELAY_MS` inter-send
 * throttles + one verify (first chunk only) — comfortably under that ~60s
 * timeout, while the client loops the cursor over the FULL row set. There is
 * deliberately NO row cap: the batch size is bounded per-REQUEST, never in total.
 */

import { z } from "zod";

/** A campaign id from FormData — coerce a string to a positive int so a
 *  missing/non-numeric/0/negative value fails as `validation` rather than
 *  resolving a bogus row (compose/actions-core.ts:84 idiom). */
export const campaignIdSchema = z.coerce.number().int().positive();

/** A recipient-set id — same positive-int coercion (rejects "0" / "-1"). */
export const recipientSetIdSchema = z.coerce.number().int().positive();

/** A template id — same positive-int coercion. */
export const templateIdSchema = z.coerce.number().int().positive();

/** An SMTP-config id the client proposes when choosing which verified server a
 *  campaign sends through (06.1 multi-server). Same positive-int coercion, so a
 *  missing/non-numeric/0/negative selection fails as `validation` up front; the
 *  parsed id is then owner-re-resolved server-side (unknown/cross-tenant →
 *  not_found), never trusted as a storage path. */
export const smtpConfigIdSchema = z.coerce.number().int().positive();

/** The chunk cursor offset — a non-negative int (offset 0 is the first chunk). */
export const chunkOffsetSchema = z.coerce.number().int().min(0);

/** The single test-send recipient address (mirror the top-level z.email() idiom,
 *  smtp/schema.ts:76). Every personalized message is redirected here. */
export const testAddressSchema = z.email("Enter a valid test address.");

/** Inter-send throttle in ms (decision A2/U2) — the delay BETWEEN sends, applied
 *  only between rows, never after the last row of a chunk. */
export const TEST_SEND_DELAY_MS = 500;

/** Rows per client-driven request (see file-level chunk-size rationale). Bounds
 *  each request's wall time under the reverse-proxy read timeout; NOT a total cap. */
export const TEST_SEND_CHUNK_SIZE = 10;
