"use client"

/**
 * A compact multi-select scope control: one chip that opens a checklist.
 * Same semantics as the office pills (empty selection means all), but it costs
 * one chip of bar width instead of one per option — which is what keeps the
 * filter bar on a single line as option sets grow.
 */

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

export interface ScopeOption {
  value: string
  label: string
  count?: number
}

export function ScopeMenu({
  label,
  options,
  value,
  onChange,
}: {
  /** Shown when nothing is picked — the name of the axis, e.g. "Cadence". */
  label: string
  options: ScopeOption[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  const picked = new Set(value)
  const toggle = (v: string) => {
    const next = new Set(picked)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next])
  }
  // The chip says what is on: one pick reads as itself, several as a count.
  const summary =
    value.length === 0
      ? label
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? label)
        : `${label} · ${value.length}`

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
          value.length > 0
            ? "border-cyan/40 bg-cyan/15 text-cyan"
            : "border-line bg-white/[0.03] text-ink-dim hover:border-cyan/40 hover:text-ink"
        }`}
      >
        {summary}
        <ChevronDown className="h-3 w-3 opacity-60" strokeWidth={2.5} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-52 rounded-lg border border-line-soft bg-[#0b1620]/95 py-1 shadow-xl shadow-black/40 backdrop-blur-md">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-ink-dim hover:bg-white/[0.05] hover:text-ink"
              onClick={() => toggle(o.value)}
            >
              <input
                type="checkbox"
                className="tbl-check pointer-events-none"
                checked={picked.has(o.value)}
                readOnly
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.count !== undefined && (
                <span className="font-mono num text-[10px] text-ink-mute">{o.count}</span>
              )}
            </button>
          ))}
          {value.length > 0 && (
            <button
              type="button"
              className="mt-1 w-full border-t border-line-soft px-2.5 pt-1.5 pb-0.5 text-left text-[10.5px] text-ink-mute hover:text-cyan"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}
