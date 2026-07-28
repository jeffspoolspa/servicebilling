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

// ADR 011: four views, one per derived state.
//   Awaiting Invoice — a WORK ORDER state (billable, no invoice yet)
//   Needs Attention  — not finished, and nothing will move it automatically
//   Open AR          — sent, not settled
//   Paid             — sent, settled
//
// "Ready to Process" is gone on purpose: in-flight is a claimable queue row,
// not a state, so it belongs as a status on the row rather than its own tab.
// "Sent" is likewise a FIELD and a filter on these tables, not a view — every
// terminal state already implies it (or an explicit skip_send waiver).
const TABS = [
  { href: "/service-billing/awaiting-invoice", label: "Awaiting Invoice" },
  { href: "/service-billing/needs-attention", label: "Needs Attention" },
  { href: "/service-billing/open-ar", label: "Open AR" },
  { href: "/service-billing/sent", label: "Paid" },
  { href: "/service-billing/audit", label: "Audit" },
] as const

export function BillingTabs({ openArCount = 0 }: { openArCount?: number }) {
  const path = usePathname()
  return (
    <div className="flex gap-1 px-7 pt-1 border-b border-line-soft">
      {TABS.map((tab) => {
        const active = path === tab.href || path.startsWith(tab.href + "/")
        const badge = tab.href === "/service-billing/open-ar" && openArCount > 0
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
            {badge && (
              <span className="ml-1.5 inline-flex items-center rounded-full border border-coral/20 bg-coral/10 px-1.5 text-[10px] font-mono text-coral align-[1px]">
                {openArCount}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
