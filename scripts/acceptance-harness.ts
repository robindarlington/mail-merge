/**
 * scripts/acceptance-harness — seed + assert for the redeploy acceptance test
 * (SC-3 / T-08-11 / T-08-12).
 *
 * This runs INSIDE the compose `web` container (bundled to a single .mjs by the
 * orchestrating `redeploy-acceptance.sh` and copied in with `docker compose cp`),
 * so it uses the EXACT in-container SQLite DB (`/data/app.db`), the container's
 * `CREDENTIAL_ENC_KEY`, and the shared `/data/uploads` the worker reads from —
 * never a host copy that could diverge. It reuses the real userId-scoped DAL and
 * crypto seed paths (lib/data + lib/crypto + lib/csv) — it hand-rolls NO inserts,
 * so the seeded data is byte-identical to what the web app would create.
 *
 *   seed:   node acceptance-harness.mjs seed   --count 12 [--stub-host host.docker.internal] [--stub-port 2525]
 *             → prints `CAMPAIGN_ID=<id>` for the shell to capture; the campaign is
 *               left in `queued` so the running worker claims and sends it.
 *   assert: node acceptance-harness.mjs assert --campaign <id> --expected <N> --rcpt-log /tmp/rcpt.jsonl
 *             → verifies the seeded data SURVIVED the redeploy, every recipient has
 *               exactly one TERMINAL send_record with a unique (campaign_id,to_addr),
 *               and the stub RCPT log recorded each recipient AT MOST once. Exits
 *               nonzero on ANY violation.
 *
 * The DB reads go through the shared `@/lib/db` client (the single opener, D-04) so
 * the harness inherits the same WAL + busy_timeout pragmas as web/worker and never
 * opens a second handle onto the file.
 */

import { existsSync, readFileSync } from "node:fs";

import { and, count, eq, inArray, sql } from "drizzle-orm";

import { db, campaigns, send_records } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { writeUpload } from "@/lib/csv/storage";
import { createRecipientSet } from "@/lib/data/recipients";
import { createTemplate } from "@/lib/data/templates";
import { createSmtpConfig } from "@/lib/data/smtp";
import { createDraftCampaign, enqueueCampaign } from "@/lib/data/campaigns";

/** A stable, obviously-synthetic tenant id — this data is throwaway. */
const ACCEPTANCE_USER = "user_acceptance_redeploy_08_04";
const DEFAULT_COUNT = 12;
const TERMINAL_STATUSES = ["sent", "failed"] as const;

/** Read `--flag value` / `--flag=value` args into a simple map. */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

/** Fail loud: print a clear message and exit nonzero (the acceptance contract). */
function fail(message: string): never {
  process.stderr.write(`ASSERT FAIL: ${message}\n`);
  process.exit(1);
}

/**
 * seed — materialize a queued campaign whose SMTP config points at the host stub.
 * Builds an N-row CSV of distinct addresses, persists it through the real upload +
 * DAL + crypto paths, and flips the campaign draft→queued so the live worker claims
 * it. Prints `CAMPAIGN_ID=<id>` on stdout.
 */
async function seed(flags: Record<string, string>): Promise<void> {
  const n = Number(flags.count ?? DEFAULT_COUNT);
  if (!Number.isInteger(n) || n <= 0) fail(`--count must be a positive integer (got ${flags.count})`);
  const stubHost = flags["stub-host"] ?? process.env.STUB_HOST ?? "host.docker.internal";
  const stubPort = Number(flags["stub-port"] ?? process.env.STUB_SMTP_PORT ?? 2525);

  // N DISTINCT recipient rows → N unique addresses (the dedup denominator).
  const header = "email,name";
  const lines = Array.from(
    { length: n },
    (_, i) => `acceptance-${i + 1}@stub.invalid,Recipient ${i + 1}`,
  );
  const csv = Buffer.from([header, ...lines].join("\n") + "\n", "utf8");

  // Persist the CSV to the SHARED /data/uploads volume via the real writer (opaque
  // uuid filename — the same path the worker resolves at materialize time).
  const { storagePath } = writeUpload(csv);

  const [set] = await createRecipientSet(ACCEPTANCE_USER, {
    filename: "acceptance-recipients.csv",
    columns_json: JSON.stringify(["email", "name"]),
    row_count: n,
    storage_path: storagePath,
    email_column: "email",
  });

  const [tpl] = await createTemplate(ACCEPTANCE_USER, {
    subject: "Acceptance {{name}}",
    body: "Hello {{name}} — redeploy acceptance for {{email}}.",
  });

  // Encrypt a THROWAWAY password with the container's CREDENTIAL_ENC_KEY — the stub
  // accepts any auth, so nothing real is used (T-08-13). Proves the enc key round-
  // trips end-to-end (a wrong/empty key would make the worker's decrypt throw).
  const secret = encrypt("acceptance-stub-password");
  const [cfg] = await createSmtpConfig(ACCEPTANCE_USER, {
    label: "Acceptance Stub",
    host: stubHost,
    port: stubPort,
    secure: false,
    username: "stub",
    password_enc: secret.enc,
    password_iv: secret.iv,
    password_tag: secret.tag,
    from_addr: "acceptance@stub.invalid",
    from_name: "Acceptance Harness",
    is_default: true,
  });

  const [draft] = await createDraftCampaign(ACCEPTANCE_USER, {
    recipient_set_id: set.id,
    template_id: tpl.id,
    smtp_config_id: cfg.id,
  });

  // Atomic draft→queued: the worker only claims `queued` campaigns.
  const queued = await enqueueCampaign(ACCEPTANCE_USER, draft.id);
  if (queued.length !== 1) fail(`enqueue did not transition campaign ${draft.id} to queued`);

  process.stdout.write(`seeded campaign ${draft.id} with ${n} recipients (stub ${stubHost}:${stubPort})\n`);
  // Machine-readable line the shell greps for the id.
  process.stdout.write(`CAMPAIGN_ID=${draft.id}\n`);
}

/** Parse the stub's JSONL RCPT log into per-address counts (missing file → empty). */
function rcptCounts(logPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(logPath)) return counts;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const { addr } = JSON.parse(t) as { addr: string };
    counts.set(addr, (counts.get(addr) ?? 0) + 1);
  }
  return counts;
}

/**
 * assert — prove survival + terminal-uniqueness + no-duplicate-delivery for the
 * seeded campaign. Any violation exits nonzero with a clear message.
 */
async function assertCampaign(flags: Record<string, string>): Promise<void> {
  const campaignId = Number(flags.campaign);
  const expected = Number(flags.expected);
  const rcptLog = flags["rcpt-log"];
  if (!Number.isInteger(campaignId)) fail(`--campaign <id> is required (got ${flags.campaign})`);
  if (!Number.isInteger(expected) || expected <= 0) fail(`--expected <N> is required (got ${flags.expected})`);
  if (!rcptLog) fail("--rcpt-log <path> is required");

  // (1) DATA SURVIVED the redeploy: the campaign row is still on the /data volume.
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaign) fail(`campaign ${campaignId} not found — data did NOT survive the redeploy`);

  const rows = await db
    .select({ to_addr: send_records.to_addr, status: send_records.status })
    .from(send_records)
    .where(eq(send_records.campaign_id, campaignId));
  if (rows.length === 0) fail(`campaign ${campaignId} has zero send_records — data did NOT survive`);

  // (2) Every recipient reached a TERMINAL state exactly once, and (3) each
  // (campaign_id,to_addr) is unique. The DB UNIQUE constraint guarantees (3); we
  // re-check it explicitly so a regression is caught here, not silently.
  const [{ terminal }] = await db
    .select({ terminal: count() })
    .from(send_records)
    .where(
      and(
        eq(send_records.campaign_id, campaignId),
        inArray(send_records.status, [...TERMINAL_STATUSES]),
      ),
    );
  if (terminal !== expected) {
    const nonTerminal = rows.filter((r) => !TERMINAL_STATUSES.includes(r.status as never));
    fail(
      `expected ${expected} terminal send_records, found ${terminal} ` +
        `(${nonTerminal.length} still non-terminal: ${nonTerminal.map((r) => r.status).join(",")})`,
    );
  }

  const [{ distinctAddrs }] = await db
    .select({ distinctAddrs: sql<number>`count(distinct ${send_records.to_addr})` })
    .from(send_records)
    .where(eq(send_records.campaign_id, campaignId));
  if (distinctAddrs !== rows.length) {
    fail(`send_records have duplicate (campaign_id,to_addr): ${rows.length} rows but ${distinctAddrs} distinct addresses`);
  }
  if (rows.length !== expected) {
    fail(`campaign ${campaignId} has ${rows.length} send_records, expected exactly ${expected}`);
  }

  // (4) NO double-send at the wire: each recipient appears AT MOST once in the stub
  // RCPT log. A duplicate line means the interrupt/resume re-delivered a row.
  const counts = rcptCounts(rcptLog);
  const dupes = [...counts.entries()].filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    fail(
      `stub recorded duplicate deliveries: ` +
        dupes.map(([a, c]) => `${a}×${c}`).join(", "),
    );
  }

  const rcptTotal = [...counts.values()].reduce((a, b) => a + b, 0);
  process.stdout.write(
    `ASSERT PASS: campaign ${campaignId} survived — ${rows.length} unique terminal send_records, ` +
      `${counts.size} unique RCPT(s) across ${rcptTotal} deliveries, no double-send.\n`,
  );
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (mode) {
    case "seed":
      await seed(flags);
      break;
    case "assert":
      await assertCampaign(flags);
      break;
    default:
      process.stderr.write(`acceptance-harness: unknown mode '${mode}' (use seed|assert)\n`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`acceptance-harness ERROR: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
