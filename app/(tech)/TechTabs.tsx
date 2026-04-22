"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

const tabs = [
  { href: "/truck-check", label: "Truck Check" },
  { href: "/sign-out", label: "Sign Out" },
] as const

export function TechTabs() {
  const pathname = usePathname()

  return (
    <nav
      role="tablist"
      aria-label="Tech sections"
      className="sticky top-0 z-10 bg-bg/80 backdrop-blur-md border-b border-line-soft"
    >
      <div className="max-w-md mx-auto flex">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + "/")
          return (
            <Link
              key={t.href}
              role="tab"
              aria-selected={active}
              href={t.href as never}
              prefetch
              className={cn(
                "flex-1 text-center py-3 text-sm font-medium min-h-11",
                "transition-colors duration-150 ease-out",
                "active:bg-white/5",
                active ? "text-ink border-b-2 border-cyan" : "text-ink-dim border-b-2 border-transparent",
              )}
            >
              {t.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
