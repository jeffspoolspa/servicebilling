"use client"

import { useState } from "react"
import { LogOut } from "lucide-react"
import { Sheet } from "@/components/ui/sheet"

/**
 * The header's top-left logo doubles as the menu trigger: tap opens a left
 * sidebar with the signed-in tech and a logout button. Logout is a plain
 * navigation to /logout?to=/tech-login — the route clears the session
 * cookies and redirects to the tech login page.
 */
export function TechMenu({ techName }: { techName: string | null }) {
  const [open, setOpen] = useState(false)

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
        <div className="flex flex-col gap-6">
          {techName && (
            <div className="text-sm text-ink-dim">
              Signed in as <span className="text-ink font-medium">{techName}</span>
            </div>
          )}
          <a
            href="/logout?to=/tech-login"
            className="flex items-center gap-2.5 h-12 px-4 rounded-[10px] border border-line-soft text-sm font-medium text-ink active:bg-white/5"
          >
            <LogOut className="w-4 h-4" strokeWidth={1.8} />
            Log out
          </a>
        </div>
      </Sheet>
    </>
  )
}
