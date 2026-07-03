"use client"

import { useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { X } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * URL-driven filter bar for the maintenance billing pages — the same shape as
 * the Work Orders filter bar: compact select dropdowns (label as placeholder,
 * cyan when active), active filters as removable chips, Clear all. Pages pass
 * the dimensions + options; every change updates the URL (and resets page).
 */
export interface FilterDef {
  key: string
  label: string
  options: { value: string; label: string }[]
}

export function BillingFilterBar({ filters }: { filters: FilterDef[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (value && value.length > 0) next.set(key, value)
      else next.delete(key)
      next.delete("page")
      router.replace(`${pathname}?${next.toString()}` as never)
    },
    [router, pathname, searchParams],
  )

  const active = filters
    .map((f) => ({ ...f, value: searchParams.get(f.key) ?? "" }))
    .filter((f) => f.value !== "")

  const clearAll = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString())
    for (const f of filters) next.delete(f.key)
    next.delete("page")
    router.replace(`${pathname}?${next.toString()}` as never)
  }, [router, pathname, searchParams, filters])

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <SelectFilter
            key={f.key}
            label={f.label}
            value={searchParams.get(f.key) ?? ""}
            options={f.options}
            onChange={(v) => setParam(f.key, v || null)}
          />
        ))}
        {active.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto text-[11px] text-ink-mute hover:text-ink transition-colors px-2 py-1"
          >
            Clear all
          </button>
        )}
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {active.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setParam(f.key, null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan/5 text-cyan px-2.5 py-0.5 text-[11px] hover:border-cyan/60 transition-colors"
            >
              <span className="text-ink-mute">{f.label}:</span>
              <span>{f.options.find((o) => o.value === f.value)?.label ?? f.value}</span>
              <X className="w-3 h-3 opacity-70" strokeWidth={2} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const active = value !== ""
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "appearance-none bg-bg-elev border rounded-md pl-2.5 pr-6 py-1.5 text-[12px] focus:outline-none transition-colors cursor-pointer",
          active
            ? "border-cyan/40 text-cyan"
            : "border-line text-ink-dim hover:border-line/80",
        )}
      >
        <option value="">{label}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-mute text-[9px]">
        ▼
      </span>
    </div>
  )
}
