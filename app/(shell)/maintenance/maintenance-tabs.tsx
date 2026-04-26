"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

/**
 * Maintenance sub-tabs, shared by every /maintenance/* page via the parent
 * layout. Mirrors the BillingTabs pattern in service-billing.
 */

const TABS = [
  { href: "/maintenance/dashboard", label: "Dashboard" },
  { href: "/maintenance/routes", label: "Routes" },
  { href: "/maintenance/visits", label: "Visits" },
  { href: "/maintenance/inventory", label: "Inventory" },
  { href: "/maintenance/techs", label: "Techs" },
] as const

export function MaintenanceTabs() {
  const path = usePathname()
  return (
    <div className="flex gap-1 px-7 pt-1 border-b border-line-soft">
      {TABS.map((tab) => {
        const active = path === tab.href || path.startsWith(tab.href + "/")
        return (
          <Link
            key={tab.href}
            href={tab.href as never}
            className={cn(
              "px-3.5 py-2.5 text-[13px] -mb-px border-b-2",
              active
                ? "text-ink border-cyan font-medium"
                : "text-ink-mute border-transparent hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
