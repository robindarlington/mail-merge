import { Separator } from "@/components/ui/separator";

/**
 * /agents — the public CLI + MCP guide (RSC, no auth/data fetch).
 *
 * The same merge-and-send engine ships as a CLI and as a stdio MCP server. The
 * code blocks below are copied VERBATIM from packages/cli/README.md (the npx
 * invocation and the mcpServers config JSON) so a reader can copy-paste them and
 * have them work unchanged.
 *
 * SECURITY (threat T-09-05, downstream Tampering): a drifted snippet would run
 * on the reader's shell or in their MCP client. Package name, flags, and the -y
 * in `npx -y` MUST match the CLI README exactly — kept as string constants here
 * and diff-checked against the README in Plan 03's snippet-parity step.
 */

// Verbatim from packages/cli/README.md (Quick start — dry-run default).
const NPX_DRY_RUN =
  "npx @robindarlington/mail-merge --csv data.csv --template msg.txt";

// Verbatim from packages/cli/README.md (Client config snippet).
const MCP_CONFIG = `{
  "mcpServers": {
    "mail-merge": {
      "command": "npx",
      "args": ["-y", "@robindarlington/mail-merge", "mcp"]
    }
  }
}`;

export default function AgentsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-[1.2]">
          CLI and MCP for agents
        </h1>
        <p className="text-base text-muted-foreground">
          The same merge-and-send engine runs from the command line or as an MCP
          server an AI agent can drive. Zero install via npx; requires Node.js 18
          or newer.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Quick start (CLI)</h2>
        <p className="text-base">
          Dry-run first — it connects to nothing and sends nothing, it just shows
          you exactly what would be sent. The CSV needs a header row; the email
          column is auto-detected and every header is available to your template
          as a merge field.
        </p>
        <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
          {NPX_DRY_RUN}
        </pre>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Dry-run, test, send</h2>
        <p className="text-base">
          The default run is a dry-run. Add{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-sm font-mono">
            --test you@example.com
          </code>{" "}
          to send the whole batch to a single address as a full rehearsal, then{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-sm font-mono">
            --send
          </code>{" "}
          to deliver one personalized email per recipient. SMTP details are read
          from the environment, never from flags — the password never lands in
          argv, shell history, or logs. Connection is verified with
          transport.verify() before any message is sent.
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Use it from an MCP client</h2>
        <p className="text-base">
          Add this to your MCP client (for example Claude Desktop&apos;s config)
          to expose the engine as typed tools:
        </p>
        <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
          {MCP_CONFIG}
        </pre>
        <p className="text-base">
          The server exposes four tools: <strong>validate-csv</strong> (columns,
          row count, detected email column, invalid-email count),{" "}
          <strong>preview-merge</strong> (the merged subject and body per row —
          read-only, sends nothing), <strong>test-send</strong> (send the whole
          batch to one address), and <strong>send</strong> (one personalized
          email per row).
        </p>
        <p className="text-base">
          Live send is deliberately gated so an agent cannot fire a batch in a
          single step. The first send call returns a preview plus a one-time
          confirmToken and delivers nothing; the second call must echo that exact
          token with identical parameters to actually deliver. A replayed,
          unknown, or mismatched token is refused.
        </p>
      </section>
    </div>
  );
}
