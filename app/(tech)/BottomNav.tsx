"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Package, ClipboardList } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useBottomBar } from "./bottom-bar"

// Bottom nav = the two modules. Each module's default landing route + the
// prefixes that count as "inside" it (so the tab stays active across sub-pages).
const modules = [
  {
    href: "/truck-check",
    label: "Inventory",
    icon: Package,
    match: ["/truck-check", "/sign-out"],
  },
  {
    href: "/follow-up",
    label: "Follow-Up",
    icon: ClipboardList,
    match: ["/follow-up"],
  },
] as const

export function BottomNav() {
  const pathname = usePathname()
  const { action } = useBottomBar()

  return (
    <div className="fixed bottom-0 inset-x-0 z-20 pb-[env(safe-area-inset-bottom)] pointer-events-none">
      <div className="max-w-md mx-auto px-4 pb-3">
        {action ? (
          // Morphed state: the nav has become the page's primary action.
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            className={cn(
              "pointer-events-auto w-full h-14 rounded-full text-base font-medium",
              "shadow-[0_8px_30px_-8px_rgba(0,0,0,0.6)]",
              "transition-[background,color,filter,transform] duration-200 ease-out",
              "active:scale-[0.98] active:brightness-95",
              action.disabled
                ? "bg-bg-elev border border-line-soft text-ink-mute cursor-not-allowed"
                : "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018]",
            )}
          >
            {action.label}
          </button>
        ) : (
          // Default state: module switcher.
          <nav
            aria-label="Modules"
            className={cn(
              "pointer-events-auto flex items-center gap-1 p-1.5 rounded-full",
              "bg-bg-elev/90 backdrop-blur-md border border-line-soft",
              "shadow-[0_8px_30px_-10px_rgba(0,0,0,0.6)]",
            )}
          >
            {modules.map((m) => {
              const active = m.match.some(
                (p) => pathname === p || pathname.startsWith(p + "/"),
              )
              const Icon = m.icon
              return (
                <Link
                  key={m.href}
                  href={m.href as never}
                  prefetch
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-0.5 py-2 rounded-full min-h-14",
                    "transition-colors duration-150 ease-out active:scale-[0.98]",
                    active
                      ? "bg-cyan/10 text-ink"
                      : "text-ink-dim hover:text-ink hover:bg-white/[0.03]",
                  )}
                >
                  <Icon
                    className={cn("w-5 h-5", active ? "text-cyan" : "")}
                    strokeWidth={active ? 2.2 : 1.8}
                  />
                  <span className="text-xs font-medium">{m.label}</span>
                </Link>
              )
            })}
          </nav>
        )}
      </div>
    </div>
  )
}
