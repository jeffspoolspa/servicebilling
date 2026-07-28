"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, X } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ActiveCustomer } from "@/lib/entities/follow-up/shared"

/**
 * Controlled bottom-sheet customer selector (searchable). The trigger lives in
 * the parent so it can be opened both from the empty-state button and the
 * selected-customer card's "Change" button. Native selects eat half the mobile
 * viewport, hence the sheet.
 */
export function CustomerSelectSheet({
  customers,
  value,
  onPick,
  onClose,
}: {
  customers: ActiveCustomer[]
  value: string
  onPick: (id: number) => void
  onClose: () => void
}) {
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState("")

  // Lock body scroll while open.
  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  const dismiss = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 180)
  }

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(
      (c) =>
        c.customer_name.toLowerCase().includes(q) ||
        (c.address ?? "").toLowerCase().includes(q),
    )
  }, [customers, query])

  return (
    <div role="dialog" aria-modal="true" aria-label="Select customer" className="fixed inset-0 z-40">
      {/* Backdrop */}
      <div
        onClick={dismiss}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-200 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_180ms_ease-out_both]",
        )}
      />

      {/* Sheet */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 h-[85dvh] flex flex-col",
          "bg-bg-elev border-t border-line rounded-t-2xl shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.5)]",
          "transition-transform ease-[cubic-bezier(0.165,0.84,0.44,1)]",
          closing
            ? "translate-y-full duration-[180ms]"
            : "translate-y-0 duration-[260ms] animate-[sheet-slide-up_260ms_cubic-bezier(0.165,0.84,0.44,1)_both]",
        )}
      >
        {/* Grab handle + header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="w-10 h-1.5 rounded-full bg-line-soft mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
          <h2 className="font-display text-base pt-2">Select customer</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className={cn(
              "w-9 h-9 grid place-items-center rounded-lg text-ink-dim",
              "hover:bg-white/5 hover:text-ink active:scale-[0.92]",
              "transition-[color,background-color,transform] duration-150 ease-out",
            )}
          >
            <X className="w-5 h-5" strokeWidth={1.8} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pb-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or address…"
            className={cn(
              "w-full h-11 px-3.5 text-base rounded-lg",
              "bg-[#0E1C2A] border border-line text-ink placeholder:text-ink-mute",
              "focus:outline-none focus:border-cyan focus-visible:ring-2 focus-visible:ring-cyan/30",
            )}
          />
        </div>

        <div className="overflow-y-auto overscroll-contain px-2 pb-6 pt-1 flex-1">
          {filtered.length === 0 && (
            <p className="text-ink-mute text-sm px-3 py-4">No customers match.</p>
          )}
          {filtered.map((c) => {
            const active = String(c.customer_id) === value
            return (
              <button
                key={c.customer_id}
                type="button"
                onClick={() => onPick(c.customer_id)}
                className={cn(
                  "w-full min-h-11 px-3 py-2.5 flex items-center gap-3 rounded-lg text-left",
                  "transition-[background-color,color,transform] duration-150 ease-out",
                  "active:scale-[0.99]",
                  active ? "bg-cyan/10 text-ink" : "text-ink hover:bg-white/[0.04]",
                )}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-base truncate">{c.customer_name}</span>
                  {c.address && (
                    <span className="block text-xs text-ink-mute truncate">{c.address}</span>
                  )}
                </span>
                {active && <Check className="w-4 h-4 text-cyan shrink-0" strokeWidth={2.2} />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * Select-styled trigger button for the empty state (no customer chosen yet).
 */
export function CustomerTrigger({
  onOpen,
  chevronStyle,
}: {
  onOpen: () => void
  chevronStyle: React.CSSProperties
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      style={chevronStyle}
      className={cn(
        "appearance-none w-full h-11 pl-3.5 pr-10 text-base rounded-lg text-left",
        "bg-[#0E1C2A] border border-line text-ink-mute",
        "transition-[border-color,box-shadow,transform] duration-150 ease-out",
        "focus:outline-none focus:border-cyan focus-visible:ring-2 focus-visible:ring-cyan/30",
        "active:scale-[0.99] truncate",
      )}
    >
      Select customer…
    </button>
  )
}
