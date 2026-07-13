"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PenLine, Settings, Users } from "lucide-react";

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
 * Two active slots this phase — Dashboard and SMTP Settings. The active item is
 * detected from the current pathname and rendered with the sidebar accent
 * indicator (the `isActive` prop drives shadcn's data-active accent styling, the
 * only accent use permitted for nav per the UI-SPEC Color contract).
 *
 * Client component because active detection needs `usePathname()`. Future slots
 * (Campaigns, History) arrive in later phases — see the placeholder note below;
 * they drop into this same SidebarMenu without reshaping the shell.
 */
const NAV_ITEMS = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Recipients", href: "/recipients", icon: Users },
  { title: "Compose", href: "/compose", icon: PenLine },
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
              {/*
                Future nav slots (D-11): "Campaigns" and "History" pages arrive in
                later phases (CSV upload → send → history). They belong here, in
                the same SidebarMenu, so the shell never needs restructuring — add
                a SidebarMenuItem per the pattern above when those routes exist.
              */}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
