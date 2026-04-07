"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Home,
  FileText,
  ClipboardList,
  Users,
  HardHat,
  BarChart3,
  Settings,
} from "lucide-react"
import { cn } from "@/lib/utils/cn"

const items = [
  { href: "/", icon: Home, label: "Home" },
  { href: "/invoices", icon: FileText, label: "Invoices" },
  { href: "/work-orders", icon: ClipboardList, label: "Work Orders" },
  { href: "/customers", icon: Users, label: "Customers" },
  { href: "/employees", icon: HardHat, label: "Employees" },
  { href: "/service-billing", icon: BarChart3, label: "Service Billing" },
] as const

export function Rail() {
  const path = usePathname()

  return (
    <aside className="w-16 bg-[#07121B] border-r border-line-soft flex flex-col items-center py-3.5 gap-1.5">
      <Link
        href="/"
        className="w-9 h-9 rounded-[9px] grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold text-lg shadow-[0_8px_20px_-8px_rgb(56_189_248_/_0.4)] mb-2.5"
      >
        J
      </Link>

      {items.map((item) => {
        const Icon = item.icon
        const active =
          item.href === "/" ? path === "/" : path === item.href || path.startsWith(item.href + "/")
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            className={cn(
              "w-10 h-10 rounded-[9px] grid place-items-center transition-colors",
              active
                ? "text-cyan bg-cyan/10 shadow-[inset_2px_0_0_rgb(var(--cyan))]"
                : "text-ink-mute hover:text-ink hover:bg-white/5",
            )}
          >
            <Icon className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </Link>
        )
      })}

      <div className="flex-1" />

      <Link
        href="/admin"
        title="Admin"
        className="w-10 h-10 rounded-[9px] grid place-items-center text-ink-mute hover:text-ink hover:bg-white/5 transition-colors"
      >
        <Settings className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </Link>
    </aside>
  )
}
