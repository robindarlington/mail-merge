import { auth, currentUser } from "@clerk/nextjs/server";

import { getSmtpConfigForUser, toSmtpConfigDto } from "@/lib/data/smtp";
import { SmtpWizard } from "@/components/smtp/smtp-wizard";

/**
 * /settings/smtp — the SMTP onboarding wizard and its edit flow (SMTP-01/02/05).
 *
 * This RSC loads the caller's existing config via the userId-scoped DAL
 * (getSmtpConfigForUser) and hands the CLIENT ONLY the password-free DTO
 * (toSmtpConfigDto) plus the Clerk primary email used to prefill the test-send
 * recipient. The encrypted password triple is never referenced here, so it
 * cannot cross to the client (SMTP-04 / T-2-CRED / D-07).
 *
 * The same page is the edit flow: a non-null `initial` puts the wizard in edit
 * mode (prefilled fields, blank password).
 */
export default async function SmtpSettingsPage() {
  const { userId } = await auth();
  const row = userId ? await getSmtpConfigForUser(userId) : undefined;
  const initial = row ? toSmtpConfigDto(row) : null;

  const user = await currentUser();
  const testEmailDefault =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-[1.2]">
          {initial ? "SMTP settings" : "Connect your email server"}
        </h1>
        <p className="text-base text-muted-foreground">
          {initial
            ? "Update your sending configuration below."
            : "Set up the SMTP server Mail Merge will send through — verified before it's saved."}
        </p>
      </div>

      <SmtpWizard initial={initial} testEmailDefault={testEmailDefault} />
    </div>
  );
}
