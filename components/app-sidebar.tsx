"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PenLine, Send, Settings, Users } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * Left-hand nav for the authenticated app shell (D-11).
 *
 * Active slots — Dashboard, Lists, Compose, Campaigns, and SMTP Settings. The
 * active item is detected from the current pathname and rendered with the sidebar
 * accent indicator (the `isActive` prop drives shadcn's data-active accent styling,
 * the only accent use permitted for nav per the UI-SPEC Color contract). The
 * `startsWith` check keeps "Campaigns" active on the /campaigns/[id] drill-down.
 *
 * Client component because active detection needs `usePathname()`.
 */
const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Lists", href: "/lists", icon: Users },
  { title: "Compose", href: "/compose", icon: PenLine },
  { title: "Campaigns", href: "/campaigns", icon: Send },
  { title: "SMTP Settings", href: "/settings/smtp", icon: Settings },
] as const;

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4">
        <span className="text-xl font-semibold">Mail Merge</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
