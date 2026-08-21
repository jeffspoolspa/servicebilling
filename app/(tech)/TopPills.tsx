"use client"

import { useEffect, useState } from "react"
import { Wifi, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useTopBar } from "./top-bar"

const PILL =
  "pointer-events-auto flex items-center rounded-full bg-bg-elev/85 backdrop-blur-md border border-line-soft shadow-[0_4px_16px_-6px_rgba(0,0,0,0.5)]"

/**
 * The floating top row (ruled 2026-08-21, Robinhood-style): no header strip —
 * content scrolls underneath frosted pills. Left pill = the drawer trigger
 * (passed in so the server layout can compose it), centre pill = the page's
 * claimed top-bar content, right pill = live connectivity.
 */
export function TopPills({ menu }: { menu: React.ReactNode }) {
  const { content } = useTopBar()
  return (
    <div className="fixed inset-x-0 top-0 z-30 pointer-events-none">
      <div
        className="max-w-md mx-auto px-4 flex items-center justify-between gap-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 10px)" }}
      >
        {/* menu + connectivity cluster left; the right side stays blank
            until a page claims it */}
        <div className="flex items-center gap-2">
          <div className={cn(PILL, "p-1")}>{menu}</div>
          <ConnectivityPill />
        </div>
        {content != null && (
          <div className={cn(PILL, "min-w-0 h-9 px-4 text-sm text-ink")}>{content}</div>
        )}
      </div>
    </div>
  )
}

/**
 * navigator.onLine + the online/offline events — the browser's own signal.
 * Online stays quiet (muted icon); offline goes loud, because a tech at a
 * no-signal pool needs to know their submit will fail BEFORE they fill the
 * form.
 */
function ConnectivityPill() {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    setOnline(navigator.onLine)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  return online ? (
    <div className={cn(PILL, "w-9 h-9 justify-center shrink-0")} aria-label="Online">
      <Wifi className="w-4 h-4 text-emerald-400/80" strokeWidth={2} />
    </div>
  ) : (
    <div
      className={cn(
        PILL,
        "h-9 px-3.5 gap-1.5 shrink-0 text-xs font-medium",
        "!bg-amber-400/15 !border-amber-400/30 text-amber-300",
      )}
      role="status"
    >
      <WifiOff className="w-4 h-4" strokeWidth={2} />
      Offline
    </div>
  )
}
