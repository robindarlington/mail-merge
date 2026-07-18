import Link from "next/link";

import { Separator } from "@/components/ui/separator";

/**
 * /docs — the public, signed-out usage guide (RSC, no auth/data fetch).
 *
 * A static walk-through of one merge run in the order the app enforces it:
 * onboard → upload → compose → preview → test → confirm → send. Copy is fixed by
 * the 09-UI-SPEC Docs table (exact page heading, intro, and the seven step
 * headings); prose is accurate to the shipped app (verify-before-save SMTP,
 * email-column detection, {{merge-field}} autocomplete, empty-value preview
 * warnings, whole-batch test-send, a confirmation gate, live progress + a
 * downloadable record). Nests inside the marketing shell (header + SiteFooter),
 * so BRAND-01 attribution rides along. Inline links use the neutral underlined
 * idiom (D-5), never accent.
 */
export default function DocsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-[1.2]">
          Using Mail Merge
        </h1>
        <p className="text-base text-muted-foreground">
          A run goes onboard → upload → compose → preview → test → confirm →
          send. Here is each step.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">1. Connect your SMTP server</h2>
        <p className="text-base">
          Add your own SMTP server — host, port, username, password, and the
          from address. Mail Merge runs a live connection check and only saves
          the server once it verifies, so a bad host or credential is caught
          before any campaign. Your password is encrypted at rest and never
          shown back to you.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">2. Upload your CSV</h2>
        <p className="text-base">
          Upload a CSV with a header row and one row per recipient. Mail Merge
          detects the email column automatically and lets you override it if the
          guess is wrong. Every column header becomes a merge field you can drop
          into the email.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">3. Compose your email</h2>
        <p className="text-base">
          Write a plain-text subject and body in the editor. Type{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-sm">{"{{"}</code> to
          autocomplete a merge field from your CSV columns — in both the subject
          and the body — so each recipient gets their own values filled in.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">4. Preview and validate</h2>
        <p className="text-base">
          Step through the merge row by row to see exactly what each recipient
          will receive. Rows with an empty value for a merge field you used are
          flagged with a warning, so you can fix your data before sending
          anything blank.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">5. Test-send</h2>
        <p className="text-base">
          Send the whole batch to a single address to proof it end to end. Every
          row is really merged and delivered, but all of it lands in one inbox —
          a full dress rehearsal that touches none of your recipients.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">6. Confirm and send</h2>
        <p className="text-base">
          A live send is gated behind an explicit confirmation so a batch can
          never fire by accident. Once you confirm, Mail Merge verifies the SMTP
          connection again and starts delivering one personalized email per row
          through your own server.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">
          7. Watch progress and download the record
        </h2>
        <p className="text-base">
          A background worker sends each email with a throttle between rows and
          reports live per-recipient progress — sent, failed, and how many
          remain. When the run finishes, you keep a saved record of exactly what
          was sent and to whom, downloadable as a CSV.
        </p>
      </section>

      <Separator />

      <p className="text-base text-muted-foreground">
        Prefer the command line or an AI agent? See the{" "}
        <Link
          href="/agents"
          className="underline underline-offset-4 hover:text-foreground"
        >
          agents page
        </Link>
        .
      </p>
    </div>
  );
}
