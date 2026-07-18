# @robindarlington/mail-merge

CSV-driven, plain-text **mail merge over your own SMTP** — from the command line or
as an [MCP](https://modelcontextprotocol.io) server that an AI agent can drive. One
personalized email per CSV row, sent through _your_ SMTP server. No shared sending
infrastructure, no rich-text, no lock-in.

Same merge-and-send engine, two front-ends:

- **CLI** — `npx @robindarlington/mail-merge …` for humans and scripts.
- **MCP server** — `mail-merge mcp` exposes the engine to Claude Desktop and other
  MCP clients as typed tools.

Runs with **zero install** via `npx`. Requires Node.js **>= 18**.

---

## Quick start (CLI)

Dry-run first — it connects to nothing and sends nothing, it just shows you exactly
what _would_ be sent:

```bash
npx @robindarlington/mail-merge --csv data.csv --template msg.txt              # dry-run (default)
```

Send the whole batch to one address to proof it end-to-end:

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=you@example.com SMTP_PASS=… FROM_ADDR=you@example.com \
  npx @robindarlington/mail-merge --csv data.csv --template msg.txt --test you@example.com
```

Send for real — one personalized email per recipient:

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=you@example.com SMTP_PASS=… FROM_ADDR=you@example.com \
  npx @robindarlington/mail-merge --csv data.csv --template msg.txt --send --delay-ms 3000
```

Interrupted a send? Re-run with `--resume` — it skips rows already recorded as sent
in the receipts file (see [Receipts & --resume](#receipts----resume)):

```bash
SMTP_HOST=… SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… FROM_ADDR=… \
  npx @robindarlington/mail-merge --csv data.csv --template msg.txt --send --resume
```

### CSV + template

The CSV needs a header row; the email column is auto-detected (override with
`--email-column`). Every header is available to the template as `{{column}}`:

```csv
email,name,company
alice@example.com,Alice,Acme
bob@example.com,Bob,Globex
```

The template's first `Subject:` line becomes the subject; everything after the blank
line is the plain-text body:

```text
Subject: Hello {{name}}

Hi {{name}},

Thanks for being a customer at {{company}}.
```

### Options

| Flag | Description |
| --- | --- |
| `--csv <file>` | Recipients CSV (header row + one row per recipient). **Required.** |
| `--template <file>` | Message template; first `Subject:` line is the subject. **Required.** |
| `--email-column <name>` | Override the auto-detected email column. |
| `--delay-ms <n>` | Inter-send throttle in ms (default `3000`). |
| `--test <addr>` | Send the WHOLE batch to one address (real per-row fill). |
| `--send` | Send for real, one personalized email per recipient. |
| `--receipts <file>` | JSONL receipts path (default `<csv>.receipts.jsonl`). |
| `--no-receipts` | Do not write a receipts file. |
| `--resume` | Skip addresses already recorded `sent` in the receipts. |
| `-h`, `--help` | Show help. |

---

## SMTP configuration (env only)

SMTP details are read from the **environment**, never from flags. Use your shell,
a process manager, or `node --env-file=.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `SMTP_HOST` | yes | SMTP server hostname. |
| `SMTP_PORT` | yes | SMTP server port (e.g. `587` STARTTLS, `465` implicit TLS). |
| `SMTP_USER` | yes | SMTP username. |
| `SMTP_PASS` | no\* | SMTP password. |
| `FROM_ADDR` | yes | Envelope/from address. |
| `FROM_NAME` | no | Sender display name. |
| `SMTP_SECURE` | no | `"true"` for implicit TLS, `"false"` (default) otherwise. **Set this explicitly** — it is never inferred from the port. |

\* **The password never comes from a command-line flag** — there is deliberately no
`--password` option, so it can never leak into `argv`, shell history, `ps`, logs, or
receipts. Supply it via `SMTP_PASS`, or omit it and you will be prompted for it with
a hidden (no-echo) prompt.

Connection is verified with `transport.verify()` **before** any message is sent, so a
bad host or credential fails fast instead of half-way through your list.

---

## Receipts & `--resume`

Every `--send`/`--test` run appends a JSONL **receipt** per row (`to`, `status`,
`messageId`/`error`, `timestamp` — never the password) to `<csv>.receipts.jsonl`
(override with `--receipts`, disable with `--no-receipts`).

`--resume` reads that file and **skips any address already recorded as `sent`**.
This is **at-least-once**, not exactly-once: each receipt is flushed to disk before
the next send, which shrinks — but cannot fully close — the window where a crash
_after_ delivery but _before_ the receipt is written could cause a re-send on resume.
In practice resume-safe re-runs will not double-send a recipient that was recorded.

---

## Use as an MCP server (for AI agents)

`mail-merge mcp` starts a stdio [Model Context Protocol](https://modelcontextprotocol.io)
server exposing the same engine as four typed tools:

- **`validate-csv`** — columns, row count, detected email column, invalid-email count.
- **`preview-merge`** — the merged subject/body per row (read-only; sends nothing).
- **`test-send`** — send the whole batch to one address over your SMTP.
- **`send`** — send one personalized email per row, behind a two-step confirm gate.

### Client config snippet

Add this to your MCP client (e.g. Claude Desktop's config):

```json
{
  "mcpServers": {
    "mail-merge": {
      "command": "npx",
      "args": ["-y", "@robindarlington/mail-merge", "mcp"]
    }
  }
}
```

The agent supplies the SMTP settings and CSV **text** as tool parameters (the server
never reads arbitrary files on the agent's behalf), and the password is passed only
into the transport — it is never echoed back in any tool result, preview, or log.

### Two-step send confirmation

Live `send` is deliberately gated so an agent cannot fire a batch in a single step:

1. The **first** `send` call (no `confirmToken`) returns a **preview** plus a
   one-time `confirmToken` and delivers **nothing**.
2. The **second** `send` call, echoing that exact `confirmToken` with identical
   parameters, consumes the token and actually delivers. A replayed, unknown, or
   parameter-mismatched token is refused.

`test-send` and `send` accept the same optional `delayMs` throttle and `receiptsPath`
(JSONL receipts + `--resume`-style skip-set) as the CLI.

---

## Security notes

- **BYO SMTP** — mail is sent through _your_ SMTP server; there is no shared relay.
- **Password never in argv/logs/receipts** — env var or hidden prompt only.
- **Explicit TLS** — `SMTP_SECURE` is an explicit boolean, never inferred from the port.
- **Verify before send** — `transport.verify()` gates every batch.

---

## Author

Built by **Robin Darlington**. I turn spreadsheets and manual workflows into small,
reliable tools like this one. If you have a CSV-shaped problem you'd like automated,
[get in touch](https://github.com/robindarlington).

## License

MIT
