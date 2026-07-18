import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * /self-host — the public host-your-own guide (RSC, no auth/data fetch).
 *
 * Documents the deployment shape (single Next.js app + background worker sharing
 * one SQLite file on a Docker volume) and the environment-variable contract,
 * mirroring every deploy-relevant variable in .env.example by NAME and SEMANTIC
 * only (the SMTP_* block seeds local dev / CLI parity only and is excluded — in
 * the web app each user brings their own SMTP through onboarding). The
 * build-vs-runtime split is called out explicitly: NEXT_PUBLIC_CLERK_* are
 * inlined by `next build` (build-time), everything else is read by the
 * container at start (runtime); worker tunables get their own group since all
 * of them are optional overrides with compose-supplied defaults.
 *
 * SECURITY (threat T-09-02, Information Disclosure): this page is world-readable,
 * so it renders ONLY placeholder variable names and the `openssl rand -base64 32`
 * generator command — NEVER a real key value and NEVER a full .env dump. A leaked
 * real secret here would be unrecoverable.
 */

const RUNTIME_VARS: { name: string; detail: string }[] = [
  {
    name: "DATABASE_PATH",
    detail:
      "Path to the SQLite database file. In production this lives on the shared /data Docker volume (for example /data/app.db); in dev it sits under ./data.",
  },
  {
    name: "UPLOADS_PATH",
    detail:
      "Directory where uploaded CSVs are written. In production set it to /data/uploads so uploads land on the same durable /data volume as the database.",
  },
  {
    name: "CREDENTIAL_ENC_KEY",
    detail:
      "Runtime secret. The 32-byte master key that encrypts SMTP credentials at rest. Generate it with openssl rand -base64 32. The app fails to start if it is missing or not 32 bytes. Inject it via a secret, never a build arg.",
  },
  {
    name: "CLERK_SECRET_KEY",
    detail:
      "Runtime secret. The server-only Clerk key. It must never reach the browser, git history, or a build arg — the container reads it at start.",
  },
  {
    name: "HOSTNAME",
    detail:
      "Bind address for the Next.js standalone server. Must be 0.0.0.0 in Docker so the container accepts traffic from outside its own network namespace.",
  },
  {
    name: "PORT",
    detail: "Port the web server listens on. Defaults to 3000.",
  },
];

const WORKER_VARS: { name: string; detail: string }[] = [
  {
    name: "SEND_DELAY_MS",
    detail:
      "Pause between individual sends in milliseconds — the per-recipient throttle. Default 1000.",
  },
  {
    name: "WORKER_POLL_MS",
    detail:
      "How often the worker polls for queued work when idle, in milliseconds. Default 2000.",
  },
  {
    name: "WORKER_LEASE_SEC",
    detail:
      "Lease/visibility window for a claimed job, in seconds; a hung send is reclaimed after this elapses. Default 300.",
  },
  {
    name: "WAL_CHECKPOINT_MS",
    detail:
      "How often the worker forces a SQLite WAL checkpoint (ms) to keep the -wal sidecar bounded between campaigns. Default 3600000 (1 hour).",
  },
  {
    name: "ORPHAN_SWEEP_MS",
    detail:
      "How often the worker sweeps orphaned upload and attachment files off the /data volume, in milliseconds. Default 3600000 (1 hour).",
  },
  {
    name: "ATTACHMENT_ORPHAN_DAYS",
    detail:
      "Age in days after which an orphaned attachment file becomes eligible for the sweep. Default 7.",
  },
];

const BUILD_TIME_VARS: { name: string; detail: string }[] = [
  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    detail:
      "Build-time. The client-safe Clerk publishable key. next build inlines it into the JS bundle, so changing it requires a rebuild, not a restart.",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
    detail:
      "Build-time. The dedicated sign-in route (/sign-in). Setting it also keeps auth redirects pointed at the sign-in page instead of looping on the current URL.",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
    detail: "Build-time. The dedicated sign-up route (/sign-up).",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL",
    detail:
      "Build-time. Where users land after a successful sign-in (/dashboard).",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL",
    detail:
      "Build-time. Where users land after a successful sign-up (/dashboard).",
  },
];

export default function SelfHostPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-[1.2]">
          Host your own
        </h1>
        <p className="text-base text-muted-foreground">
          Mail Merge is a single Next.js app plus a background worker, sharing
          one SQLite file on a Docker volume. You can run it on your own VPS with
          Docker Compose — for example via Coolify.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold">Environment variables</h2>
          <p className="text-base text-muted-foreground">
            These mirror .env.example — the complete, documented contract in the
            repo — variable names and semantics only. Build-time variables
            (Clerk publishable keys and URLs) are inlined at build; everything
            else is read at runtime. The only .env.example entries not listed
            here are the SMTP_* values, which seed local dev and CLI parity —
            in the web app every user brings their own SMTP through onboarding.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Runtime variables</CardTitle>
            <CardDescription className="text-base">
              Read by the container at start. Changing one needs only a restart
              or redeploy.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {RUNTIME_VARS.map((v) => (
              <div key={v.name} className="flex flex-col gap-2">
                <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
                  {v.name}
                </pre>
                <p className="text-base">{v.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              Worker tunables (runtime, optional)
            </CardTitle>
            <CardDescription className="text-base">
              Read by the background worker at start. All are safe to omit —
              the compose file supplies these same defaults — and exist so you
              can override them per-deploy.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {WORKER_VARS.map((v) => (
              <div key={v.name} className="flex flex-col gap-2">
                <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
                  {v.name}
                </pre>
                <p className="text-base">{v.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Build-time variables</CardTitle>
            <CardDescription className="text-base">
              Inlined into the bundle by next build. Changing one requires a
              rebuild, not a restart.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {BUILD_TIME_VARS.map((v) => (
              <div key={v.name} className="flex flex-col gap-2">
                <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
                  {v.name}
                </pre>
                <p className="text-base">{v.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Generate your encryption key</h2>
        <p className="text-base">
          Generate CREDENTIAL_ENC_KEY with openssl rand -base64 32. The app fails
          to start if it is missing or not 32 bytes. Never commit a real key.
        </p>
        <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm font-mono">
          openssl rand -base64 32
        </pre>
        <p className="text-base text-muted-foreground">
          Copy the output into CREDENTIAL_ENC_KEY as a runtime secret. The
          command above is the only thing you paste — this page never shows a
          real key, and you should never commit one.
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Deploy</h2>
        <p className="text-base">
          Deploy from a Git push; the compose build pack rebuilds the image and
          restarts the containers against the shared /data volume.
        </p>
      </section>
    </div>
  );
}
