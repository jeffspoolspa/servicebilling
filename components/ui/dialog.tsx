"use client"

import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Minimal reusable modal dialog. Controlled (`open` + `onClose`). Closes on
 * backdrop click and Escape, locks body scroll while open, and portals to
 * <body> so it escapes any transformed/overflow-hidden ancestor.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn("relative w-full max-w-lg rounded-lg border border-line bg-surface shadow-card", className)}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-line-soft">
            <h3 className="text-ink font-semibold text-[15px]">{title}</h3>
            <button type="button" onClick={onClose} className="text-ink-mute hover:text-ink transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
