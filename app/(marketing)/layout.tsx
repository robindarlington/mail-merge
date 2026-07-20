import Link from "next/link";

import { SiteFooter } from "@/components/site-footer";
import { Button } from "@/components/ui/button";

/**
 * Public marketing shell (D-7) for the signed-out surface: the landing at `/`
 * and the docs/self-host/agents pages. Route groups are URL-transparent, so
 * pages under (marketing) keep their real paths while inheriting this header +
 * footer.
 *
 * Structure: a flex-col column with a fixed-height top bar (wordmark left, a
 * neutral "Sign in" affordance right — outline, NOT accent, per D-4, because the
 * single page accent is the landing "Get started" CTA), the page content in
 * <main>, and the attribution SiteFooter (BRAND-01) beneath it. The footer is
 * rendered HERE (not in the root layout) so it does not double-render on the
 * authenticated (app) pages. The root layout already provides ClerkProvider —
 * do NOT add another one here.
 */
export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="brand-marketing flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b px-6">
        <Link href="/" className="text-xl font-semibold">
          Mail Merge
        </Link>
        <Button asChild variant="outline">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </header>
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
