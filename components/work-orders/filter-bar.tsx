"use client"

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { X, Search as SearchIcon } from "lucide-react"
import type { FilterOptions } from "@/lib/queries/work-orders"
import { cn } from "@/lib/utils/cn"

/**
 * URL-driven filter bar for the Work Orders browser.
 *
 * Every filter is a search param; the page reads them server-side and
 * re-renders. The bar is a thin client wrapper that updates the URL on
 * change. Active filters also render as chips below the bar — click the
 * X on a chip to remove that filter; "Clear all" nukes everything.
 */

// Keys that carry list filters (one URL param → one filter).
const LIST_KEYS = [
  "month",
  "office",
  "tech",
  "department",
  "type",
  "bonus",
] as const
type ListKey = (typeof LIST_KEYS)[number]

interface Props {
  options: FilterOptions
}

export function WorkOrdersFilterBar({ options }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Local q state so typing feels responsive — commits to URL on submit /
  // Enter / blur (debounced).
  const [qInput, setQInput] = useState(searchParams.get("q") ?? "")
  const qDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep qInput in sync when URL changes externally (e.g. Back button).
  useEffect(() => {
    setQInput(searchParams.get("q") ?? "")
  }, [searchParams])

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (value && value.length > 0) next.set(key, value)
      else next.delete(key)
      // Any filter change resets pagination to page 1.
      next.delete("page")
      router.replace(`${pathname}?${next.toString()}` as never)
    },
    [router, pathname, searchParams],
  )

  const clearAll = useCallback(() => {
    router.replace(pathname as never)
  }, [router, pathname])

  // Debounced commit for the search text.
  useEffect(() => {
    if (qDebounceRef.current) clearTimeout(qDebounceRef.current)
    qDebounceRef.current = setTimeout(() => {
      const current = searchParams.get("q") ?? ""
      if (qInput !== current) setParam("q", qInput || null)
    }, 300)
    return () => {
      if (qDebounceRef.current) clearTimeout(qDebounceRef.current)
    }
  }, [qInput, searchParams, setParam])

  const activeFilters = currentFilters(searchParams, options)
  const hasActive = activeFilters.length > 0

  // Tech filter: if the user has picked a department, narrow the tech
  // dropdown to techs in that department. Keeps the ~40 names manageable.
  const deptFilter = searchParams.get("department")
  const techsForDropdown = deptFilter
    ? options.techs.filter((t) => t.department === deptFilter)
    : options.techs

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter
          label="Month"
          value={searchParams.get("month") ?? ""}
          onChange={(v) => setParam("month", v || null)}
          options={options.months.map((m) => ({
            value: m,
            label: formatMonth(m),
          }))}
        />
        <SelectFilter
          label="Office"
          value={searchParams.get("office") ?? ""}
          onChange={(v) => setParam("office", v || null)}
          options={options.offices.map((o) => ({ value: o, label: o }))}
        />
        <SelectFilter
          label="Department"
          value={searchParams.get("department") ?? ""}
          onChange={(v) => setParam("department", v || null)}
          options={options.departments.map((d) => ({ value: d, label: d }))}
        />
        <SelectFilter
          label="Tech"
          value={searchParams.get("tech") ?? ""}
          onChange={(v) => setParam("tech", v || null)}
          options={techsForDropdown.map((t) => ({
            value: t.name,
            label: deptFilter ? t.name : `${t.name} · ${t.department}`,
          }))}
        />
        <SelectFilter
          label="Type"
          value={searchParams.get("type") ?? ""}
          onChange={(v) => setParam("type", v || null)}
          options={options.types.map((t) => ({ value: t, label: t }))}
        />
        <SelectFilter
          label="Bonus"
          value={searchParams.get("bonus") ?? ""}
          onChange={(v) => setParam("bonus", v || null)}
          options={[
            { value: "true", label: "In bonus pool" },
            { value: "false", label: "Excluded" },
          ]}
        />

        <div className="relative ml-auto">
          <SearchIcon
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-mute"
            strokeWidth={1.8}
          />
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search WO, customer, invoice #…"
            className="bg-bg-elev border border-line rounded-md pl-8 pr-2.5 py-1.5 text-[12px] text-ink w-64 placeholder:text-ink-mute focus:outline-none focus:border-cyan"
          />
        </div>

        {hasActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-ink-mute hover:text-ink transition-colors px-2 py-1"
          >
            Clear all
          </button>
        )}
      </div>

      {hasActive && (
        <div className="flex flex-wrap gap-1.5">
          {activeFilters.map((f) => (
            <button
              key={`${f.key}:${f.value}`}
              type="button"
              onClick={() => setParam(f.key, null)}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan/5 text-cyan px-2.5 py-0.5 text-[11px] hover:border-cyan/60 transition-colors"
            >
              <span className="text-ink-mute">{f.labelKey}:</span>
              <span>{f.labelValue}</span>
              <X className="w-3 h-3 opacity-70" strokeWidth={2} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface FilterChip {
  key: string
  value: string
  labelKey: string
  labelValue: string
}

function currentFilters(
  searchParams: URLSearchParams,
  options: FilterOptions,
): FilterChip[] {
  const out: FilterChip[] = []
  for (const k of LIST_KEYS) {
    const v = searchParams.get(k)
    if (!v) continue
    out.push({
      key: k,
      value: v,
      labelKey: prettyKey(k),
      labelValue:
        k === "month"
          ? formatMonth(v)
          : k === "bonus"
            ? v === "true"
              ? "In bonus pool"
              : "Excluded"
            : v,
    })
  }
  // Synthetic tech_other bucket chip (non-removable single-click — clear via
  // "Clear all"). Shows up when the dashboard drilled into "Other departments".
  if (searchParams.get("tech_other") === "1") {
    out.push({
      key: "tech_other",
      value: "1",
      labelKey: "Tech",
      labelValue: "Other departments (non-Service)",
    })
  }
  // Synthetic CTA-group bucket — drilldown from Zach's bonus row.
  if (searchParams.get("cta_group") === "1") {
    out.push({
      key: "cta_group",
      value: "1",
      labelKey: "Tech",
      labelValue: "Chance + Travis + Aaron",
    })
  }
  const q = searchParams.get("q")
  if (q) {
    out.push({
      key: "q",
      value: q,
      labelKey: "Search",
      labelValue: q,
    })
  }
  // `options` is accepted as a future extension point (validating
  // filter values against the option set); not yet used at runtime.
  void options
  return out
}

function prettyKey(k: ListKey | "q" | "tech_other" | "cta_group"): string {
  return (
    {
      month: "Month",
      office: "Office",
      tech: "Tech",
      department: "Department",
      type: "Type",
      bonus: "Bonus",
      q: "Search",
      tech_other: "Tech",
      cta_group: "Tech",
    } as const
  )[k]
}

function formatMonth(iso: string): string {
  const ym = /^\d{4}-\d{2}/.exec(iso)?.[0]
  if (!ym) return iso
  const d = new Date(`${ym}-01T00:00:00Z`)
  return d.toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
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
