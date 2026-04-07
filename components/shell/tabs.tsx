"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

interface TabsProps {
  items: Array<{ href: string; label: string }>
}

export function Tabs({ items }: TabsProps) {
  const path = usePathname()
  return (
    <div className="flex gap-1 px-7 pt-4 border-b border-line-soft">
      {items.map((item) => {
        const active = path === item.href
        return (
          <Link
            key={item.href}
            href={item.href as never}
            className={cn(
              "px-3.5 py-2.5 text-[13px] -mb-px border-b-2",
              active
                ? "text-ink border-cyan font-medium"
                : "text-ink-mute border-transparent hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}
