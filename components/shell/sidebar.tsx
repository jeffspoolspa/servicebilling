"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import {
  Home as HomeIcon,
  Waves,
  Wrench,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Collapsible left sidebar — top-level department/module switcher.
 *
 * States:
 *   - Expanded (~208px): icons + labels
 *   - Collapsed (~56px): icons only, tooltip-on-hover via native `title`
 *
 * The collapsed/expanded state is persisted to localStorage so the sidebar
 * stays how the user left it across page loads. SSR renders expanded by
 * default; we rehydrate the saved state on mount.
 *
 * Items:
 *   - Home         → /home (placeholder for now — future landing / news)
 *   - Service      → /service (dashboard + billing)
 *   - Maintenance  → /maintenance (placeholder for now — future ops)
 *   - Admin (footer) → /admin
 *
 * Sub-module nav (Dashboard | Billing for Service) lives in the
 * top ModuleHeader, NOT here — this sidebar only switches between
 * top-level departments.
 */

const STORAGE_KEY = "shell.sidebar.collapsed"

interface Item {
  href: string
  icon: typeof HomeIcon
  label: string
  /** Path-prefix set that should light this item up. */
  matches: string[]
}

const ITEMS: Item[] = [
  { href: "/home", icon: HomeIcon, label: "Home", matches: ["/home"] },
  {
    href: "/service",
    icon: Waves,
    label: "Service",
    matches: [
      "/service",
      "/service-billing",
      "/work-orders",
      "/invoices",
      "/customers",
    ],
  },
  {
    href: "/maintenance",
    icon: Wrench,
    label: "Maintenance",
    matches: ["/maintenance"],
  },
]

const ADMIN_ITEM: Item = {
  href: "/admin",
  icon: Settings,
  label: "Admin",
  matches: ["/admin", "/employees"],
}

export function Sidebar() {
  const path = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === "1") setCollapsed(true)
    } catch {
      // ignore storage access errors
    }
    setHydrated(true)
  }, [])

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
    } catch {
      // ignore
    }
  }

  // Opacity guard to prevent flash of expanded → collapsed after hydration.
  const rootStyle: React.CSSProperties = hydrated ? {} : { opacity: 0 }

  return (
    <aside
      className={cn(
        "border-r border-line-soft bg-[#07121B] flex flex-col transition-[width] duration-200 ease-out",
        collapsed ? "w-14" : "w-52",
      )}
      style={rootStyle}
    >
      {/* Brand + toggle row */}
      <div className="flex items-center h-14 px-2.5 border-b border-line-soft">
        <Link
          href={"/service" as never}
          className="w-9 h-9 rounded-[9px] grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold text-lg shadow-[0_8px_20px_-8px_rgb(56_189_248_/_0.4)] shrink-0"
          title="Jeff's Pool & Spa"
        >
          J
        </Link>
        {!collapsed && (
          <div className="ml-2.5 flex-1 min-w-0">
            <div className="font-display text-[13px] leading-tight tracking-tight text-ink truncate">
              Jeff&apos;s Billing
            </div>
            <div className="text-ink-mute text-[10px] uppercase tracking-[0.14em]">
              Service Ops
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-7 h-7 rounded-md grid place-items-center text-ink-mute hover:text-ink hover:bg-white/5 transition-colors"
        >
          {collapsed ? (
            <PanelLeftOpen className="w-4 h-4" strokeWidth={1.8} />
          ) : (
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.8} />
          )}
        </button>
      </div>

      {/* Main nav */}
      <div className="flex flex-col gap-0.5 px-2 py-3 flex-1">
        {ITEMS.map((item) => (
          <SidebarLink
            key={item.href}
            item={item}
            path={path}
            collapsed={collapsed}
          />
        ))}
      </div>

      {/* Footer: Admin */}
      <div className="px-2 py-3 border-t border-line-soft">
        <SidebarLink item={ADMIN_ITEM} path={path} collapsed={collapsed} />
      </div>
    </aside>
  )
}

function SidebarLink({
  item,
  path,
  collapsed,
}: {
  item: Item
  path: string
  collapsed: boolean
}) {
  const Icon = item.icon
  const active = item.matches.some(
    (m) => path === m || path.startsWith(m + "/"),
  )
  return (
    <Link
      href={item.href as never}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] transition-colors",
        active
          ? "bg-cyan/10 text-cyan shadow-[inset_2px_0_0_rgb(var(--cyan))]"
          : "text-ink-dim hover:bg-white/[0.04] hover:text-ink",
      )}
    >
      <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={1.8} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  )
}
