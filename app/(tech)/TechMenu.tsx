"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut } from "lucide-react"
import { Sheet } from "@/components/ui/sheet"
import { cn } from "@/lib/utils/cn"
import { visibleModules } from "./nav"

/**
 * The header's top-left logo opens the side nav: identity block up top,
 * module links in the middle, logout pinned at the bottom (the Expensify
 * drawer layout, ruled 2026-08-21). Module switching lives HERE — the bottom
 * bar is the action bar. Tap-to-open only: the left-edge swipe belongs to the
 * browser's back gesture on iOS.
 */
export function TechMenu({
  techName,
  showModules = false,
  hideInventory = false,
}: {
  techName: string | null
  showModules?: boolean
  hideInventory?: boolean
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const initials =
    techName
      ?.split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() ?? "J"

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="w-8 h-8 rounded-[8px] grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold active:scale-95 transition-transform"
      >
        J
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} side="left" title="Field" className="max-w-[280px]">
        <div className="flex flex-col h-full min-h-[70dvh]">
          {/* Identity block */}
          {techName && (
            <div className="flex flex-col items-center gap-2.5 pb-6">
              <div className="w-16 h-16 rounded-full grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold text-xl">
                {initials}
              </div>
              <div className="text-base font-medium text-ink">{techName}</div>
            </div>
          )}

          {/* Modules */}
          {showModules && (
            <nav aria-label="Modules" className="flex flex-col gap-1 border-t border-line-soft pt-3">
              {visibleModules(hideInventory).map((m) => {
                const active = m.match.some((p) => pathname === p || pathname.startsWith(p + "/"))
                const Icon = m.icon
                return (
                  <Link
                    key={m.href}
                    href={m.href as never}
                    prefetch
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 h-12 px-4 rounded-[10px] text-sm font-medium",
                      "transition-colors duration-150 active:scale-[0.99]",
                      active ? "bg-cyan/10 text-ink" : "text-ink-dim hover:bg-white/[0.03]",
                    )}
                  >
                    <Icon className={cn("w-5 h-5", active && "text-cyan")} strokeWidth={active ? 2.2 : 1.8} />
                    {m.label}
                  </Link>
                )
              })}
            </nav>
          )}

          {/* Logout pinned to the bottom */}
          <div className="mt-auto pt-6">
            <a
              href="/logout?to=/tech-login"
              className="flex items-center gap-2.5 h-12 px-4 rounded-[10px] border border-line-soft text-sm font-medium text-ink active:bg-white/5"
            >
              <LogOut className="w-4 h-4" strokeWidth={1.8} />
              Log out
            </a>
          </div>
        </div>
      </Sheet>
    </>
  )
}
