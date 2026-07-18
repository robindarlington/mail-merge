import { SiteFooter } from "@/components/site-footer";

/**
 * Minimal layout for the Clerk sign-up route (SC4). Mirrors the sign-in layout:
 * the sign-up page sits OUTSIDE both the (app) and (marketing) layout groups, so
 * this layout nests the existing centered <SignUp/> page unchanged and appends
 * the attribution footer (BRAND-01) beneath it. No extra ClerkProvider (root
 * already provides one); the Clerk component is not altered.
 */
export default function SignUpLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
