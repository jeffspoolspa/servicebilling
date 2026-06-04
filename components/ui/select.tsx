"use client"

import { useState } from "react"
import { ChevronDown, Check } from "lucide-react"
import { cn } from "@/lib/utils/cn"

export interface SelectOption {
  value: string
  label: string
}

/**
 * Themed dropdown select — a styled trigger + popover, replacing the native
 * <select>. Renders a hidden input (when `name` is given) so it works inside a
 * <form>/FormData submit. Click-away closes via a transparent backdrop.
 */
export function Select({
  value,
  onChange,
  options,
  name,
  placeholder = "Select…",
  disabled = false,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  name?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  return (
    <div className={cn("relative", className)}>
      {name && <input type="hidden" name={name} value={value} />}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink hover:border-cyan focus:border-cyan focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={selected ? "text-ink truncate" : "text-ink-mute truncate"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={cn("w-4 h-4 text-ink-mute shrink-0 transition-transform", open && "rotate-180")} strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full min-w-max rounded-md border border-line bg-bg-elev shadow-card py-1 max-h-64 overflow-auto">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={cn(
                  "w-full flex items-center justify-between gap-3 text-left px-3 py-1.5 text-[13px] hover:bg-white/5 transition-colors",
                  o.value === value ? "text-cyan" : "text-ink-dim",
                )}
              >
                {o.label}
                {o.value === value && <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
