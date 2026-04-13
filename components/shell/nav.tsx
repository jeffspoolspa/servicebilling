"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

interface NavGroup {
  heading: string
  items: Array<{
    href: string
    label: string
    count?: number
  }>
}

const groups: NavGroup[] = [
  {
    heading: "Queue",
    items: [
      { href: "/service-billing/awaiting-invoice", label: "Awaiting Invoice" },
      { href: "/service-billing/queue", label: "Ready to Process" },
      { href: "/service-billing/needs-attention", label: "Needs Review" },
      { href: "/service-billing/sent", label: "Processed" },
    ],
  },
  {
    heading: "Objects",
    items: [
      { href: "/invoices", label: "Invoices" },
      { href: "/work-orders", label: "Work Orders" },
      { href: "/customers", label: "Customers" },
      { href: "/employees", label: "Employees" },
      { href: "/service-billing/payment-methods", label: "Payment Methods" },
    ],
  },
  {
    heading: "Automation",
    items: [
      { href: "/admin/sync-log", label: "Sync Log" },
      { href: "/admin/classification-rules", label: "Classification Rules" },
      { href: "/admin/ion-mapping", label: "ION Mapping" },
    ],
  },
]

export function Nav() {
  const path = usePathname()

  return (
    <nav className="w-60 border-r border-line-soft bg-[#0A1622] py-4.5 px-3.5 flex flex-col gap-4">
      <div className="flex flex-col gap-0.5 px-1.5 pb-3 border-b border-line-soft">
        <div className="font-display text-lg tracking-tight">Jeff&apos;s Billing</div>
        <div className="text-ink-mute text-[11px] uppercase tracking-[0.14em]">Service Ops</div>
      </div>

      {groups.map((group) => (
        <div key={group.heading}>
          <h5 className="text-ink-mute text-[10px] font-semibold tracking-[0.16em] uppercase px-1.5 mb-1">
            {group.heading}
          </h5>
          {group.items.map((item) => {
            const active = path === item.href || path.startsWith(item.href + "/")
            return (
              <Link
                key={item.href}
                href={item.href as never}
                className={cn(
                  "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px]",
                  active
                    ? "bg-gradient-to-r from-cyan/10 to-transparent text-ink shadow-[inset_2px_0_0_rgb(var(--cyan))]"
                    : "text-ink-dim hover:bg-white/[0.04] hover:text-ink",
                )}
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    active ? "bg-cyan shadow-[0_0_0_3px_rgb(56_189_248_/_0.12)]" : "bg-ink-mute",
                  )}
                />
                {item.label}
                {item.count != null && (
                  <span
                    className={cn(
                      "ml-auto font-mono text-[11px]",
                      active ? "text-cyan" : "text-ink-mute",
                    )}
                  >
                    {item.count}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
