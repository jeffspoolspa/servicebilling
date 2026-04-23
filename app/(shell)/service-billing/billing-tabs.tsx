"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

/**
 * Billing sub-tabs, shared by every /service-billing/* page via the
 * parent layout. One active underline; hover tint on idle tabs.
 *
 * Kept inline in the billing route group so it doesn't leak into other
 * parts of the shell — it's specific to this module's workflow.
 */

const TABS = [
  { href: "/service-billing/awaiting-invoice", label: "Awaiting Invoice" },
  { href: "/service-billing/queue", label: "Ready to Process" },
  { href: "/service-billing/needs-attention", label: "Needs Review" },
  { href: "/service-billing/sent", label: "Processed" },
  { href: "/service-billing/audit", label: "Audit" },
] as const

export function BillingTabs() {
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
