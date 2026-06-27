/**
 * Mail merge: send each recipient in the CSV their new mailbox credentials.
 *
 * Edit the message in  email-template.txt  ({{email}} and {{password}} are
 * replaced per recipient). SMTP login comes from .env (see .env.example) so no
 * secret lives in this file.
 *
 *   npm run dry            # DRY RUN: prints what it would send, sends nothing
 *   npm run test -- you@x  # send the WHOLE batch to one address to preview
 *   npm run send           # really send to every recipient
 *
 * (Equivalent without npm:  node --env-file=.env send-credentials.ts [--send | --test ADDR])
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import nodemailer from "nodemailer";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(HERE, "..", "PETR-EMAIL.csv"); // change if your CSV moves
const TEMPLATE_PATH = resolve(HERE, "email-template.txt");
const DELAY_MS = 3000; // pause between sends to stay friendly with the SMTP server

type Recipient = { email: string; password: string };

/** Minimal CSV reader: header row + one row per line, split at the FIRST comma
 *  (so passwords may safely contain commas). */
function loadRecipients(path: string): Recipient[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines.shift();
  if (!header || !/email/i.test(header)) {
    throw new Error(`CSV must start with an "email,password" header. Got: ${header ?? "<empty>"}`);
  }
  return lines.map((line, i) => {
    const comma = line.indexOf(",");
    if (comma === -1) throw new Error(`Row ${i + 2} has no comma: ${line}`);
    const email = line.slice(0, comma).trim();
    const password = line.slice(comma + 1).trim();
    if (!email || !password) throw new Error(`Row ${i + 2} missing email or password.`);
    return { email, password };
  });
}

/** Template file: first "Subject:" line becomes the subject, the rest the body. */
function loadTemplate(path: string): { subject: string; body: string } {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^Subject:\s*(.*)\r?\n/i);
  if (!match) throw new Error('email-template.txt must start with a "Subject: ..." line.');
  return { subject: match[1].trim(), body: raw.slice(match[0].length).replace(/^\r?\n/, "") };
}

function fill(text: string, r: Recipient): string {
  return text.replaceAll("{{email}}", r.email).replaceAll("{{password}}", r.password);
}

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`Missing env var ${name} (set it in .env).`);
  return v ?? "";
}

/** Ask a question on the terminal without echoing the typed characters. */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    anyRl._writeToOutput = (s) => { if (!muted) anyRl.output.write(s); };
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true; // hide everything typed after the prompt is shown
  });
}

const HELP = `
Mail merge — send each person in PETR-EMAIL.csv their new mailbox credentials.

WHAT IT DOES
  Reads ../PETR-EMAIL.csv (columns: email,password), fills the message in
  email-template.txt for each row ({{email}} and {{password}}), and sends it
  over your SMTP server. One personalized email per row.

SETUP (one time)
  1. Edit the message:   email-template.txt   (the first "Subject:" line is the subject)
  2. Copy .env.example to .env and fill in your SMTP details.
     If you leave SMTP_PASS blank, the script asks for it securely at run time.

RUN  (always preview first)
  npm run dry              Preview everything. Sends NOTHING. Start here.
  npm run test -- you@x    Send the WHOLE batch to ONE address to proof it.
  npm run send             Send for real, one email per recipient.

  Without npm:
  node --env-file=.env send-credentials.ts [--send | --test ADDR | --help]

NOTES
  • SMTP login is verified before any mail goes out.
  • Sends are spaced a few seconds apart and logged one per line.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const send = args.includes("--send");
  const testIdx = args.indexOf("--test");
  const testAddr = testIdx !== -1 ? args[testIdx + 1] : undefined;
  if (testIdx !== -1 && !testAddr) throw new Error("--test needs an address, e.g. --test you@example.com");
  const live = send || Boolean(testAddr);

  const recipients = loadRecipients(CSV_PATH);
  const tpl = loadTemplate(TEMPLATE_PATH);

  console.log(`${recipients.length} recipient(s) loaded from ${CSV_PATH}`);
  if (testAddr) console.log(`TEST mode: every message goes to ${testAddr}\n`);
  else if (send) console.log("LIVE mode: messages go to each real recipient\n");
  else console.log("DRY RUN: nothing will be sent (use npm run test -- ADDR, or npm run send)\n");

  const fromName = process.env.FROM_NAME || "Service Informatique";
  const fromAddr = live ? env("FROM_ADDR") : "noreply@example.com";

  let transport: nodemailer.Transporter | undefined;
  if (live) {
    const port = Number(env("SMTP_PORT"));
    const user = env("SMTP_USER");
    let pass = process.env.SMTP_PASS;
    if (!pass) pass = await promptHidden(`SMTP password for ${user} (input hidden): `);
    if (!pass) throw new Error("No SMTP password provided.");
    transport = nodemailer.createTransport({
      host: env("SMTP_HOST"),
      port,
      secure: port === 465, // 465 = implicit SSL; 587 uses STARTTLS automatically
      auth: { user, pass },
    });
    await transport.verify();
    console.log("SMTP connection OK.\n");
  }

  let sent = 0;
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const to = testAddr ?? r.email;
    const tag = `[${i + 1}/${recipients.length}]`;
    if (live && transport) {
      try {
        await transport.sendMail({
          from: { name: fromName, address: fromAddr },
          to,
          subject: tpl.subject,
          text: fill(tpl.body, r),
        });
        sent++;
        console.log(`${tag} sent -> ${to}  (creds for ${r.email})`);
      } catch (e) {
        console.log(`${tag} FAILED -> ${to}: ${(e as Error).message}`);
      }
      if (i < recipients.length - 1) await new Promise((res) => setTimeout(res, DELAY_MS));
    } else {
      console.log(`${tag} would send -> ${to}  (creds for ${r.email})`);
    }
  }

  if (transport) transport.close();
  console.log(live ? `\nDone. ${sent}/${recipients.length} sent.` : "\nDry run complete.");
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
