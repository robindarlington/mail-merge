import { SiteFooter } from "@/components/site-footer";

/**
 * Minimal layout for the Clerk sign-in route (SC4). The sign-in page lives
 * OUTSIDE both the (app) and (marketing) layout groups, so the attribution
 * footer (BRAND-01) would otherwise be missing here. This layout nests the
 * existing centered <SignIn/> page unchanged and appends the SiteFooter beneath
 * it. It adds no ClerkProvider (the root layout already provides one) and does
 * not alter the Clerk component.
 */
export default function SignInLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
