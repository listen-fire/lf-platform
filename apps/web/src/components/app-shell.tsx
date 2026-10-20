"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useIsMobile } from "@/lib/use-is-mobile";
import { Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);

  // Default collapsed on mobile
  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [pathname, isMobile]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  // Cmd+K is handled by GlobalSearch (opens search modal)

  return (
    <div className="flex h-full">
      {/* Mobile overlay backdrop */}
      {isMobile && !collapsed && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          onClick={toggle}
          aria-hidden="true"
        />
      )}

      <Sidebar collapsed={collapsed} onToggle={toggle} isMobile={isMobile} />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-clip">
        <main className="flex flex-1 flex-col overflow-hidden bg-white">
          {isMobile && collapsed && (
            <div className="flex h-14 flex-shrink-0 items-center border-b border-gray-100 px-3">
              <button
                onClick={toggle}
                aria-label="Open navigation"
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
              >
                <Menu size={18} />
              </button>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
