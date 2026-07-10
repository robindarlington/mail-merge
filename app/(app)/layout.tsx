import { UserButton } from "@clerk/nextjs";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteFooter } from "@/components/site-footer";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

/**
 * Authenticated app shell (D-11 / D-12). Every signed-in page in the (app) route
 * group nests inside this layout, which nests inside the root layout — so the
 * ClerkProvider from app/layout.tsx is NOT duplicated here.
 *
 * Structure: shadcn SidebarProvider wrapping the AppSidebar nav and a
 * SidebarInset content column. The column has a top bar (sidebar trigger left,
 * Clerk UserButton top-right), the page content in a 640px container (UI-SPEC
 * content max-width), and the attribution SiteFooter on every page. The
 * UserButton is themed globally via the ClerkProvider `appearance` — no
 * per-instance appearance tuning here (D-10).
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-8">
          <SidebarTrigger />
          <UserButton />
        </header>
        <main className="flex flex-1 flex-col p-8">
          <div className="mx-auto w-full max-w-2xl">{children}</div>
        </main>
        <SiteFooter />
      </SidebarInset>
      {/* Sonner toast host — required for the wizard's success toasts to render. */}
      <Toaster />
    </SidebarProvider>
  );
}
