import { auth, currentUser } from "@clerk/nextjs/server";

import { listSmtpConfigsForUser, toSmtpConfigDto } from "@/lib/data/smtp";
import { ServerList } from "@/components/smtp/server-list";

/**
 * /settings/smtp — the multi-server SMTP settings surface (SMTP-01/02/05, 06.1
 * MSMTP-01/05). This RSC lists the caller's servers via the userId-scoped DAL
 * (listSmtpConfigsForUser, default-first) and hands the CLIENT ONLY the
 * password-free DTOs (toSmtpConfigDto) plus the Clerk primary email used to
 * prefill the reused wizard's test-send recipient. The encrypted password triple
 * is never referenced here, so it cannot cross to the client (SMTP-04 / T-061-12).
 *
 * The ServerList island owns add/edit (reusing SmtpWizard per server),
 * set-default, and the destructive delete + in-use guard.
 */
export default async function SmtpSettingsPage() {
  const { userId } = await auth();
  const rows = userId ? await listSmtpConfigsForUser(userId) : [];
  const configs = rows.map(toSmtpConfigDto);

  const user = await currentUser();
  const testEmailDefault =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-[1.2]">SMTP servers</h1>
        <p className="text-base text-muted-foreground">
          The email servers Mail Merge can send through. Add as many as you need
          and choose one per campaign.
        </p>
      </div>

      <ServerList configs={configs} testEmailDefault={testEmailDefault} />
    </div>
  );
}
