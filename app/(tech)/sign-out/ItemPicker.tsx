"use client"

import { useEffect, useRef, useState } from "react"
import { Check, X } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { SignOutItem } from "@/lib/entities/inventory-signout/types"
import {
  SIGNOUT_CATEGORIES,
  SIGNOUT_CATEGORY_LABELS,
} from "@/lib/entities/inventory-signout/signout-items"

interface Props {
  items: SignOutItem[]
  value: string
  onChange: (value: string) => void
  chevronStyle: React.CSSProperties
}

/**
 * Replaces a native <select> so the mobile OS picker doesn't consume half the
 * viewport. Renders a button that looks like the select; tapping opens a
 * full-height bottom sheet with all options grouped by category.
 */
export function ItemPicker({ items, value, onChange, chevronStyle }: Props) {
  const [open, setOpen] = useState(false)
  const selected = items.find((i) => String(i.id) === value)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const handlePick = (id: number) => {
    onChange(String(id))
    setOpen(false)
    // Return focus to the trigger for keyboard users.
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={chevronStyle}
        className={cn(
          "appearance-none w-full h-11 pl-3.5 pr-10 text-base rounded-lg text-left",
          "bg-[#0E1C2A] border border-line",
          selected ? "text-ink" : "text-ink-mute",
          "transition-[border-color,box-shadow,transform] duration-150 ease-out",
          "focus:outline-none focus:border-cyan focus-visible:ring-2 focus-visible:ring-cyan/30",
          "active:scale-[0.99]",
          "truncate",
        )}
      >
        {selected ? selected.display_name : "Select item…"}
      </button>

      {open && <Sheet items={items} value={value} onPick={handlePick} onClose={() => setOpen(false)} />}
    </>
  )
}

function Sheet({
  items,
  value,
  onPick,
  onClose,
}: {
  items: SignOutItem[]
  value: string
  onPick: (id: number) => void
  onClose: () => void
}) {
  const [closing, setClosing] = useState(false)

  const dismiss = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 180)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Select item"
      className="fixed inset-0 z-40"
    >
      {/* Backdrop */}
      <div
        onClick={dismiss}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-200 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_180ms_ease-out_both]",
        )}
        style={{
          animationName: closing ? undefined : "sheet-fade-in",
        }}
      />

      {/* Sheet */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 max-h-[80vh] flex flex-col",
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
          <h2 className="font-display text-base pt-2">Select item</h2>
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

        <div className="overflow-y-auto overscroll-contain px-2 pb-6 pt-1">
          {SIGNOUT_CATEGORIES.map((cat) => {
            const group = items.filter((it) => it.category === cat)
            if (group.length === 0) return null
            return (
              <section key={cat} className="mb-2">
                <h3 className="text-[10px] font-semibold tracking-[0.18em] text-ink-mute uppercase px-3 py-1.5">
                  {SIGNOUT_CATEGORY_LABELS[cat]}
                </h3>
                {group.map((it) => {
                  const active = String(it.id) === value
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => onPick(it.id)}
                      className={cn(
                        "w-full min-h-11 px-3 py-2.5 flex items-center gap-3 rounded-lg text-left text-base",
                        "transition-[background-color,color,transform] duration-150 ease-out",
                        "active:scale-[0.99]",
                        active
                          ? "bg-cyan/10 text-ink"
                          : "text-ink hover:bg-white/[0.04]",
                      )}
                    >
                      <span className="flex-1">{it.display_name}</span>
                      {active && <Check className="w-4 h-4 text-cyan" strokeWidth={2.2} />}
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
