"use client"

import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Slide-in side panel (the Dialog's sibling — same controlled API, portal,
 * Escape/backdrop close, body-scroll lock) for content that complements the
 * table behind it: drill-down summaries, review context, comparisons.
 * Right side by default.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  side = "right",
  className,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  side?: "right" | "left"
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open || typeof document === "undefined") return null

  return createPortal(
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={cn(
          "fixed inset-y-0 flex flex-col bg-[#0C1826] border-line shadow-2xl",
          "w-full max-w-2xl",
          side === "right" ? "right-0 border-l animate-sheet-in-right" : "left-0 border-r",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line-soft shrink-0">
          <div className="min-w-0">
            {title && <div className="text-[15px] font-display text-ink">{title}</div>}
            {description && (
              <div className="text-[12px] text-ink-mute mt-0.5">{description}</div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-ink-mute hover:text-ink transition-colors mt-0.5"
          >
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
