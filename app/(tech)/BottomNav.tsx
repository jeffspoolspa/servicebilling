"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils/cn"
import { useBottomBar } from "./bottom-bar"
import { visibleModules } from "./nav"

/**
 * The bottom strip is the ACTION BAR (ruled 2026-08-21): a page's primary
 * action owns it whenever one is set. Module NAVIGATION lives in the side
 * drawer (TechMenu); while the bar is idle it shows compact icon quick-access
 * to the modules so switching stays one tap.
 */
export function BottomNav({ hideInventory = false }: { hideInventory?: boolean }) {
  const pathname = usePathname()
  const { action } = useBottomBar()

  const visible = visibleModules(hideInventory)
  if (!action && visible.length < 2) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-20 pb-[env(safe-area-inset-bottom)] pointer-events-none">
      <div className="max-w-md mx-auto px-4 pb-3">
        {action ? (
          // The page's primary action owns the bar.
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
          // Idle: compact icon quick-access — full names live in the drawer.
          <nav
            aria-label="Quick access"
            className={cn(
              "pointer-events-auto flex items-center gap-1 p-1 rounded-full w-fit mx-auto",
              "bg-bg-elev/90 backdrop-blur-md border border-line-soft",
              "shadow-[0_8px_30px_-10px_rgba(0,0,0,0.6)]",
            )}
          >
            {visible.map((m) => {
              const active = m.match.some((p) => pathname === p || pathname.startsWith(p + "/"))
              const Icon = m.icon
              return (
                <Link
                  key={m.href}
                  href={m.href as never}
                  prefetch
                  aria-label={m.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "grid place-items-center w-12 h-12 rounded-full",
                    "transition-colors duration-150 ease-out active:scale-[0.95]",
                    active
                      ? "bg-cyan/10 text-cyan"
                      : "text-ink-dim hover:text-ink hover:bg-white/[0.03]",
                  )}
                >
                  <Icon className="w-5 h-5" strokeWidth={active ? 2.2 : 1.8} />
                </Link>
              )
            })}
          </nav>
        )}
      </div>
    </div>
  )
}
