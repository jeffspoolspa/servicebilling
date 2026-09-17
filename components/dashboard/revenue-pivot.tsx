"use client"

import { Fragment, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import type { Dimension, Measure, PivotResult } from "@/lib/queries/revenue"
import { TECH_OTHER_BUCKET } from "@/lib/queries/revenue"

/**
 * Breakdown pivot — star of the Service Dashboard. This is a controlled
 * component: filter state (dimension / measure / year) lives in the
 * parent <RevenueAnalysis> wrapper. Columns are the twelve months of the
 * chosen year, each split into this year and last year, in $ thousands.
 * The month in progress compares against last year through the same day.
 * Footer: month totals, then the running year-to-date for both years. The pivot surfaces the controls + the table, but emits
 * changes via callbacks.
 *
 * Drilldown paths — every click navigates to /work-orders with filters:
 *   - Month column header → ?month=YYYY-MM
 *   - Row label           → ?<dim>=<value>
 *   - Cell                → ?<dim>=<value>&month=YYYY-MM
 *   - "Other departments" row (tech view) → ?tech_other=1 (synthetic bucket)
 */

interface Props {
  result: PivotResult
  dimension: Dimension
  measure: Measure
  year: number
  years: number[]                       // selectable, newest first
  pending: boolean
  onDimensionChange: (d: Dimension) => void
  onMeasureChange: (m: Measure) => void
  /** Parent owns the mapping from year -> Jan..Dec range. */
  onYearChange: (y: number) => void
}

export function RevenuePivot({
  result,
  dimension,
  measure,
  year,
  years,
  pending,
  onDimensionChange,
  onMeasureChange,
  onYearChange,
}: Props) {
  const router = useRouter()

  // Revenue in thousands, one decimal ("41.2"); counts as integers.
  const fmt = (v: number) =>
    measure === "revenue" ? (v / 1000).toFixed(1) : v.toLocaleString()

  const drillTo = useCallback(
    (opts: { dimValue?: string; month?: string }) => {
      const params = new URLSearchParams()
      if (opts.month) params.set("month", opts.month)
      if (opts.dimValue) {
        if (opts.dimValue === TECH_OTHER_BUCKET) {
          params.set("tech_other", "1")
        } else if (dimension === "location") {
          params.set("office", opts.dimValue)
        } else if (dimension === "tech") {
          params.set("tech", opts.dimValue)
        } else if (dimension === "department") {
          params.set("department", opts.dimValue)
        }
      }
      router.push(`/work-orders?${params.toString()}` as never)
    },
    [dimension, router],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
        <div className="ml-auto flex items-center gap-1.5">
          <SegmentedControl
            value={dimension}
            onChange={(v) => onDimensionChange(v as Dimension)}
            options={[
              { value: "location", label: "Location" },
              { value: "tech", label: "Tech" },
            ]}
          />
          <div className="w-px h-4 bg-line-soft mx-1" />
          <SegmentedControl
            value={measure}
            onChange={(v) => onMeasureChange(v as Measure)}
            options={[
              { value: "revenue", label: "$" },
              { value: "count", label: "#" },
            ]}
          />
          <div className="w-px h-4 bg-line-soft mx-1" />
          <select
            value={year}
            onChange={(e) => onYearChange(Number(e.target.value))}
            className="bg-bg-elev border border-line rounded-md px-2 py-1 text-[11px] text-ink"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </CardHeader>

      <div className="overflow-x-auto relative">
        {pending && (
          <div className="absolute inset-0 bg-bg-elev/40 pointer-events-none z-10" />
        )}

        {result.rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-ink-mute text-sm">
            No revenue in {year}.
          </div>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
              <tr>
                <th rowSpan={2} className="px-5 py-2 text-left font-medium sticky left-0 bg-bg-elev align-bottom border-b border-line-soft">
                  {dimension === "location" ? "Location" : dimension === "tech" ? "Tech" : "Department"}
                  {measure === "revenue" && (
                    <div className="normal-case tracking-normal text-ink-mute/60 font-normal">$ thousands</div>
                  )}
                </th>
                {result.months.map((m) => (
                  <th
                    key={m}
                    colSpan={2}
                    className="px-2 pt-2 pb-0.5 font-medium text-center num cursor-pointer hover:text-cyan transition-colors border-l border-line-soft/60"
                    onClick={() => drillTo({ month: m })}
                    title={`Open work orders invoiced in ${monthLabel(m, true)}`}
                  >
                    {monthLabel(m)}
                  </th>
                ))}
                <th colSpan={2} className="px-2 pt-2 pb-0.5 font-medium text-center num bg-bg-elev/60 border-l border-line-soft/60">
                  Total
                </th>
              </tr>
              <tr className="border-b border-line-soft text-ink-mute/60 font-mono">
                {[...result.months, "total"].map((m) => (
                  <Fragment key={m}>
                    <th className={`pl-2 pr-1 pb-1.5 font-normal text-right border-l border-line-soft/60 ${m === "total" ? "bg-bg-elev/60" : ""}`}>
                      {yy(year)}
                    </th>
                    <th className={`pl-1 pr-2 pb-1.5 font-normal text-right ${m === "total" ? "bg-bg-elev/60" : ""}`}>
                      {yy(year - 1)}
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono num">
              {result.rows.map((row) => (
                <tr key={row.key} className="border-b border-line-soft hover:bg-white/[0.02] transition-colors">
                  <td
                    className="px-5 py-1.5 sticky left-0 bg-[#0A1622] truncate max-w-[200px] cursor-pointer hover:text-cyan text-ink font-sans"
                    title={`Open work orders for ${row.key} (all months in range)`}
                    onClick={() => drillTo({ dimValue: row.key })}
                  >
                    {row.key}
                  </td>
                  {result.months.map((m) => (
                    <Pair
                      key={m}
                      current={row.byMonth[m] ?? 0}
                      prior={row.priorByMonth[m] ?? 0}
                      fmt={fmt}
                      onClick={() => drillTo({ dimValue: row.key, month: m })}
                      title={`Open ${row.key} · ${monthLabel(m, true)}`}
                    />
                  ))}
                  <Pair current={row.total} prior={row.priorTotal} fmt={fmt} total />
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-bg-elev/30">
                <td className="px-5 py-2 font-medium text-ink sticky left-0 bg-[#0A1622] font-sans">Total</td>
                {result.months.map((m) => (
                  <Pair
                    key={m}
                    current={result.monthTotals[m] ?? 0}
                    prior={result.priorMonthTotals[m] ?? 0}
                    fmt={fmt}
                    onClick={() => drillTo({ month: m })}
                    strong
                  />
                ))}
                <Pair current={result.grandTotal} prior={result.priorGrandTotal} fmt={fmt} total strong />
              </tr>
              <tr className="bg-bg-elev/30">
                <td className="px-5 py-2 text-ink-dim sticky left-0 bg-[#0A1622] font-sans">Year to date</td>
                {ytdPairs(result).map((p, i) => (
                  <Pair key={result.months[i]} current={p.current} prior={p.prior} fmt={fmt} blank={p.blank} />
                ))}
                <Pair current={result.grandTotal} prior={result.priorGrandTotal} fmt={fmt} total />
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </Card>
  )
}

/**
 * One month (or the total): this year, then last year. This year's figure is
 * tinted green when at or above last year's and coral when below; zero is a
 * dash. Last year sits beside it, muted.
 */
function Pair({ current, prior, fmt, onClick, title, total, strong, blank }: {
  current: number
  prior: number
  fmt: (v: number) => string
  onClick?: () => void
  title?: string
  total?: boolean
  strong?: boolean
  blank?: boolean
}) {
  const bg = total ? "bg-bg-elev/40" : ""
  const tone = current <= 0 ? "text-ink-mute/40"
    : prior <= 0 ? (strong ? "text-ink" : "text-ink-dim")
    : current >= prior ? "text-grass" : "text-coral"
  const clickable = onClick && current > 0
  return (
    <>
      <td
        className={`pl-2 pr-1 py-1.5 text-right border-l border-line-soft/60 ${bg} ${tone} ${clickable ? "cursor-pointer hover:text-cyan" : ""} ${strong ? "font-medium" : ""}`}
        onClick={clickable ? onClick : undefined}
        title={clickable ? title : undefined}
      >
        {blank || current <= 0 ? "—" : fmt(current)}
      </td>
      <td className={`pl-1 pr-2 py-1.5 text-right text-ink-mute ${bg}`}>
        {blank || prior <= 0 ? "—" : fmt(prior)}
      </td>
    </>
  )
}

/** Running totals through each month, both years; blank for months not reached. */
function ytdPairs(result: PivotResult): Array<{ current: number; prior: number; blank: boolean }> {
  let c = 0, p = 0
  return result.months.map((m) => {
    const reached = (result.monthTotals[m] ?? 0) > 0 || (result.priorMonthTotals[m] ?? 0) > 0
    c += result.monthTotals[m] ?? 0
    p += result.priorMonthTotals[m] ?? 0
    return { current: c, prior: p, blank: !reached }
  })
}

function yy(year: number): string {
  return `'${String(year).slice(2)}`
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-bg-elev p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            "px-2.5 py-1 text-[11px] rounded transition-colors " +
            (opt.value === value
              ? "bg-cyan/15 text-cyan"
              : "text-ink-mute hover:text-ink")
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function monthLabel(iso: string, long = false): string {
  const d = new Date(iso + "T00:00:00Z")
  return d.toLocaleString("en-US", {
    month: long ? "long" : "short",
    year: long ? "numeric" : undefined,
    timeZone: "UTC",
  })
}
