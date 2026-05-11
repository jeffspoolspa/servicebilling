"use client"

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useCallback } from "react"
import { X } from "lucide-react"
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
  "date_from",
  "date_to",
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
      {/* Row 1: filter dropdowns + Clear all */}
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
        <DateFilter
          label="From"
          value={searchParams.get("date_from") ?? ""}
          onChange={(v) => setParam("date_from", v || null)}
        />
        <DateFilter
          label="To"
          value={searchParams.get("date_to") ?? ""}
          onChange={(v) => setParam("date_to", v || null)}
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
        {hasActive && (
          <button
            type="button"
            onClick={clearAll}
            className="ml-auto text-[11px] text-ink-mute hover:text-ink transition-colors px-2 py-1"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Row 2: filter chips (only when active) */}
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

      {/* Search field lives in the table CardHeader (mounted in
          /work-orders/page.tsx) so it sits inline with the count pill,
          totals, and Download CSV button — out of the dropdown row's
          way. */}
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
      date_from: "From",
      date_to: "To",
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

/**
 * Native HTML5 date input. We keep the input itself blank with a placeholder
 * label until the user picks a date — that way "From" / "To" feels like a
 * filter widget rather than an empty form field. Border flips to cyan when
 * a value is set, matching SelectFilter's active state.
 */
function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const active = value !== ""
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 bg-bg-elev border rounded-md pl-2.5 pr-2 py-1 text-[12px] cursor-pointer transition-colors",
        active
          ? "border-cyan/40 text-cyan"
          : "border-line text-ink-dim hover:border-line/80",
      )}
    >
      <span className="text-[11px]">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[12px] outline-none cursor-pointer w-[7.5rem]"
      />
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            onChange("")
          }}
          className="text-ink-mute hover:text-ink -mr-0.5"
          title="Clear"
        >
          <X className="w-3 h-3" strokeWidth={2} />
        </button>
      )}
    </label>
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
