"use client";

import { useCallback, useState, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart2,
  Coins,
  PanelLeftClose,
  PanelLeftOpen,
  TrendingUp,
  Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

function isPathActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavItem({
  href,
  icon,
  label,
  active,
  collapsed,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        title={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          active
            ? "bg-primary-50 text-primary-700"
            : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
        }`}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={`relative flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-primary-50 font-medium text-primary-700"
          : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SignOutIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  isMobile,
}: {
  collapsed: boolean;
  onToggle: () => void;
  isMobile: boolean;
}) {
  const pathname = usePathname();
  const { email, logout } = useAuth();

  const iconOnly = !isMobile && collapsed;

  // Resizable width (desktop expanded only)
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 320;
  const SIDEBAR_DEFAULT = 224;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem("admin-sidebar-width");
      if (stored) {
        const n = parseInt(stored, 10);
        if (!isNaN(n)) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
      }
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      dragStartX.current = e.clientX;
      dragStartWidth.current = sidebarWidth;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebarWidth],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - dragStartX.current;
    setSidebarWidth(
      Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, dragStartWidth.current + delta),
      ),
    );
  }, []);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      try {
        localStorage.setItem("admin-sidebar-width", String(sidebarWidth));
      } catch {}
    },
    [sidebarWidth],
  );

  const expanded = !iconOnly && !isMobile;

  return (
    <aside
      style={expanded ? { width: sidebarWidth } : undefined}
      className={`flex flex-shrink-0 flex-col border-r border-gray-200/80 bg-white transition-all duration-200 ${
        isMobile
          ? `fixed inset-y-0 left-0 z-50 h-full w-72 shadow-xl ${collapsed ? "-translate-x-full" : "translate-x-0"}`
          : `relative h-full ${iconOnly ? "w-12" : expanded ? "" : "w-56"}`
      }`}
    >
      {/* Logo + toggle */}
      <div
        className={`flex h-14 items-center gap-2 text-[24px] font-medium tracking-tight text-[#8778F7] ${
          iconOnly ? "justify-center px-2" : "px-4 justify-between"
        }`}
      >
        <img
          src="/logo.svg"
          alt=""
          className="h-[24px] w-[24px] flex-shrink-0"
        />
        {!iconOnly && (
          <span className="flex-0 whitespace-nowrap text-[20px] tracking-[0.15em]">
            ADMIN
          </span>
        )}
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 ${
            iconOnly ? "hidden" : ""
          }`}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* Nav */}
      <nav
        className={`flex-1 overflow-y-auto pb-4 ${
          iconOnly ? "flex flex-col items-center gap-0.5 px-1.5" : "px-2"
        }`}
      >
        <NavItem
          href="/feed"
          icon={<Activity size={16} className="shrink-0" />}
          label="Feed"
          active={isPathActive(pathname, "/feed")}
          collapsed={iconOnly}
        />
        <NavItem
          href="/usage"
          icon={<BarChart2 size={16} className="shrink-0" />}
          label="Usage"
          active={isPathActive(pathname, "/usage")}
          collapsed={iconOnly}
        />
        <NavItem
          href="/llm-usage"
          icon={<Coins size={16} className="shrink-0" />}
          label="LLM Usage"
          active={isPathActive(pathname, "/llm-usage")}
          collapsed={iconOnly}
        />
        <NavItem
          href="/teams"
          icon={<Users size={16} className="shrink-0" />}
          label="Teams"
          active={isPathActive(pathname, "/teams")}
          collapsed={iconOnly}
        />
        <NavItem
          href="/journey"
          icon={<TrendingUp size={16} className="shrink-0" />}
          label="Onboarding"
          active={isPathActive(pathname, "/journey")}
          collapsed={iconOnly}
        />
      </nav>

      {/* User / sign-out */}
      <div
        className={`border-t border-gray-200 py-3 ${iconOnly ? "flex flex-col items-center gap-1 px-1.5" : "px-2"}`}
      >
        {iconOnly ? (
          <>
            <button
              onClick={onToggle}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <PanelLeftOpen size={15} />
            </button>
            <button
              onClick={logout}
              title={email ?? "Sign out"}
              aria-label="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            >
              <SignOutIcon />
            </button>
          </>
        ) : (
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
          >
            <SignOutIcon />
            <span className="truncate">{email ?? "Sign out"}</span>
          </button>
        )}
      </div>

      {/* Resize handle (desktop expanded only) */}
      {expanded && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
        />
      )}
    </aside>
  );
}
