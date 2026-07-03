"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils/cn"
import { QueueChip } from "./_components/queue-chip"
import { ProcessingChip } from "./_components/processing-chip"

/**
 * Stage tabs WITHIN the maintenance billing module (mirrors service-billing's
 * BillingTabs): each tab is a stage of the monthly billing workflow. Module
 * navigation itself lives in the top ModuleHeader — never duplicated here.
 * Preserves the selected month across tabs.
 */

const TABS = [
  { href: "/maintenance/billing", label: "Bills" },
  { href: "/maintenance/billing/review", label: "Needs Review" },
  { href: "/maintenance/billing/process", label: "Ready to Process" },
  { href: "/maintenance/billing/processed", label: "Processed" },
  { href: "/maintenance/billing/autopay", label: "Autopay" },
] as const

export function BillingStageTabs() {
  const path = usePathname()
  const params = useSearchParams()
  const month = params.get("month")
  const suffix = month ? `?month=${month}` : ""
  return (
    <div className="flex gap-1 px-7 pt-3 border-b border-line-soft">
      {TABS.map((tab) => {
        const active =
          tab.href === "/maintenance/billing"
            ? path === tab.href
            : path === tab.href || path.startsWith(tab.href + "/")
        return (
          <Link
            key={tab.href}
            href={(tab.href + suffix) as never}
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
      <QueueChip />
      <ProcessingChip />
    </div>
  )
}
