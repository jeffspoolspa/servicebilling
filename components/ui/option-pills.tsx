"use client"

import { cn } from "@/lib/utils/cn"

export interface PillOption {
  value: string
  label: string
  /** Optional trailing count, dimmed. */
  count?: number
}

type Common = {
  options: PillOption[]
  disabled?: boolean
  className?: string
  size?: "sm" | "md"
}

type SingleProps = Common & {
  multiple?: false
  value: string
  onChange: (value: string) => void
  /** Renders a hidden input so the value survives a form post. */
  name?: string
}

type MultiProps = Common & {
  multiple: true
  value: string[]
  onChange: (value: string[]) => void
  /** Label for the leading "clear" pill. Omit to hide it. */
  allLabel?: string
}

/**
 * Segmented pill option picker — shows ALL options at once; click to select.
 * Renders a hidden input (when `name` is given) so it works in a form/FormData.
 * Use instead of a <select> when the option set is small and worth seeing inline.
 *
 * Single-select by default. Pass `multiple` for a toggle set, where an empty
 * selection means "all" and the leading pill clears back to it.
 */
export function OptionPills(props: SingleProps | MultiProps) {
  const { options, disabled = false, className, size = "md" } = props
  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-[12px]"
  const base = cn(
    "inline-flex items-center rounded-full font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
    pad,
  )
  const on = "bg-cyan/15 text-cyan border-cyan/40"
  const off = "bg-white/[0.03] text-ink-dim border-line hover:border-cyan/40 hover:text-ink"

  const selected = props.multiple ? new Set(props.value) : new Set([props.value])
  const toggle = (v: string) => {
    if (!props.multiple) return props.onChange(v)
    const next = new Set(props.value)
    next.has(v) ? next.delete(v) : next.add(v)
    props.onChange([...next])
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {!props.multiple && props.name && <input type="hidden" name={props.name} value={props.value} />}

      {props.multiple && props.allLabel && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => props.onChange([])}
          aria-pressed={props.value.length === 0}
          className={cn(base, props.value.length === 0 ? on : off)}
        >
          {props.allLabel}
        </button>
      )}

      {options.map((o) => {
        const active = selected.has(o.value)
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => toggle(o.value)}
            aria-pressed={active}
            className={cn(base, active ? on : off)}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn("ml-1.5 tabular-nums", active ? "text-cyan/60" : "text-ink-mute/60")}>
                {o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
