"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { Wifi, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useTopBar } from "./top-bar"

const PILL =
  "pointer-events-auto flex items-center rounded-full bg-[#1B3B58]/95 backdrop-blur-md border border-line-soft shadow-[0_4px_16px_-6px_rgba(0,0,0,0.5)]"

/**
 * The floating top row (ruled 2026-08-21, Robinhood-style): no header strip —
 * content scrolls underneath frosted pills. Left pill = the drawer trigger
 * (passed in so the server layout can compose it), centre pill = the page's
 * claimed top-bar content, right pill = live connectivity.
 */
export function TopPills({ menu, techName }: { menu: React.ReactNode; techName?: string | null }) {
  const { content } = useTopBar()
  const pathname = usePathname()
  // The login screen stands alone — no chrome.
  if (pathname.startsWith("/tech-login")) return null
  // In flow (ruled 2026-08-21, supersedes pinned): the band scrolls away
  // with the page like everything else.
  return (
    <div className="bg-[#12283C] border-b border-line-soft">
      <div
        className="max-w-md mx-auto px-4 flex items-center justify-between gap-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 8px)", paddingBottom: "8px" }}
      >
        {/* menu + connectivity cluster left; right side = page-claimed
            content when set, else the clock + signed-in user */}
        <div className="flex items-center gap-2">
          <div className={cn(PILL, "p-1")}>{menu}</div>
          <ConnectivityPill />
        </div>
        {content != null ? (
          <div className={cn(PILL, "min-w-0 h-9 px-4 text-sm text-ink")}>{content}</div>
        ) : (
          <ClockPill techName={techName} />
        )}
      </div>
    </div>
  )
}

/** Time + who's signed in — first name and last initial, minute-fresh. */
function ClockPill({ techName }: { techName?: string | null }) {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  if (!now) return null
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  const short = techName
    ? techName.split(/\s+/).length > 1
      ? `${techName.split(/\s+/)[0]} ${techName.split(/\s+/)[1][0]}.`
      : techName
    : null
  return (
    <div className={cn(PILL, "h-9 px-3.5 gap-1.5 shrink-0 text-xs tabular-nums text-ink-dim")}>
      <span className="text-ink">{time}</span>
      {short && (
        <>
          <span className="text-ink-mute">·</span>
          <span className="truncate max-w-[96px]">{short}</span>
        </>
      )}
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
