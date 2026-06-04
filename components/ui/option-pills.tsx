"use client"

import { cn } from "@/lib/utils/cn"

export interface PillOption {
  value: string
  label: string
}

/**
 * Segmented pill option picker — shows ALL options at once; click to select.
 * Renders a hidden input (when `name` is given) so it works in a form/FormData.
 * Use instead of a <select> when the option set is small and worth seeing inline.
 */
export function OptionPills({
  value,
  onChange,
  options,
  name,
  disabled = false,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: PillOption[]
  name?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {name && <input type="hidden" name={name} value={value} />}
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
              active
                ? "bg-cyan/15 text-cyan border-cyan/40"
                : "bg-white/[0.03] text-ink-dim border-line hover:border-cyan/40 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
