"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"

// Top tabs = the sub-pages of whichever module the current route belongs to.
const TAB_SETS: { match: string[]; tabs: { href: string; label: string }[] }[] = [
  {
    match: ["/truck-check", "/sign-out"],
    tabs: [
      { href: "/truck-check", label: "Truck Check" },
      { href: "/sign-out", label: "Sign Out" },
    ],
  },
  {
    match: ["/follow-up"],
    tabs: [
      { href: "/follow-up", label: "Submit" },
      { href: "/follow-up/history", label: "History" },
    ],
  },
]

export function ModuleTabs() {
  const pathname = usePathname()
  const set = TAB_SETS.find((s) =>
    s.match.some((p) => pathname === p || pathname.startsWith(p + "/")),
  )
  if (!set) return null

  return (
    <nav
      role="tablist"
      aria-label="Module sections"
      className="sticky top-0 z-10 bg-bg/80 backdrop-blur-md border-b border-line-soft"
    >
      <div className="max-w-md mx-auto flex">
        {set.tabs.map((t) => {
          // Exact match so /follow-up (Submit) doesn't stay active on
          // /follow-up/history.
          const active = pathname === t.href
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
                active
                  ? "text-ink border-b-2 border-cyan"
                  : "text-ink-dim border-b-2 border-transparent",
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
