"use client"

import { Fragment, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import type { Dimension, Measure, PivotResult } from "@/lib/queries/revenue"
import { TECH_OTHER_BUCKET } from "@/lib/queries/revenue"

/**
 * Breakdown pivot — star of the Service Dashboard. This is a controlled
 * component: filter state (dimension / measure / year) lives in the
 * parent <RevenueAnalysis> wrapper. Columns are the twelve months of the
 * chosen year. The pivot surfaces the controls + the table, but emits
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

  const fmt = (v: number) =>
    measure === "revenue" ? formatCurrency(v) : v.toLocaleString()

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
          <table className="w-full text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
              <tr>
                <th rowSpan={2} className="px-5 py-2.5 text-left font-medium sticky left-0 bg-bg-elev align-bottom border-b border-line-soft">
                  {dimension === "location"
                    ? "Location"
                    : dimension === "tech"
                      ? "Tech"
                      : "Department"}
                </th>
                {result.months.map((m) => (
                  <th
                    key={m}
                    colSpan={2}
                    className="px-3 pt-2.5 pb-0.5 font-medium text-right num cursor-pointer hover:text-cyan transition-colors"
                    onClick={() => drillTo({ month: m })}
                    title={`Open work orders invoiced in ${monthLabel(m, true)}`}
                  >
                    {monthLabel(m)}
                  </th>
                ))}
                <th colSpan={2} className="px-3 pt-2.5 pb-0.5 font-medium text-right num bg-bg-elev/60">
                  Total
                </th>
              </tr>
              <tr className="border-b border-line-soft text-ink-mute/60">
                {result.months.map((m) => (
                  <Fragment key={m}>
                    <th className="pl-3 pr-1 pb-1.5 font-normal text-right">{measure === "revenue" ? "$" : "#"}</th>
                    <th className="pl-1 pr-3 pb-1.5 font-normal text-right whitespace-nowrap">vs {year - 1}</th>
                  </Fragment>
                ))}
                <th className="pl-3 pr-1 pb-1.5 font-normal text-right bg-bg-elev/60">{measure === "revenue" ? "$" : "#"}</th>
                <th className="pl-1 pr-3 pb-1.5 font-normal text-right bg-bg-elev/60 whitespace-nowrap">vs {year - 1}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-line-soft hover:bg-white/[0.02] transition-colors"
                >
                  <td
                    className="px-5 py-1.5 sticky left-0 bg-[#0A1622] truncate max-w-[240px] cursor-pointer hover:text-cyan text-ink"
                    title={`Open work orders for ${row.key} (all months in range)`}
                    onClick={() => drillTo({ dimValue: row.key })}
                  >
                    {row.key}
                  </td>
                  {result.months.map((m) => {
                    const v = row.byMonth[m] ?? 0
                    return (
                      <Fragment key={m}>
                        <td
                          className={`pl-3 pr-1 py-1.5 text-right num font-mono ${
                            v > 0
                              ? "text-ink-dim hover:text-cyan cursor-pointer"
                              : "text-ink-mute/40"
                          }`}
                          onClick={() =>
                            v > 0 && drillTo({ dimValue: row.key, month: m })
                          }
                          title={
                            v > 0
                              ? `Open ${row.key} · ${monthLabel(m, true)}`
                              : undefined
                          }
                        >
                          {v > 0 ? fmt(v) : "—"}
                        </td>
                        <td className="pl-1 pr-3 py-1.5 text-right num font-mono text-[11px]">
                          <Yoy current={v} prior={row.priorByMonth[m]} />
                        </td>
                      </Fragment>
                    )
                  })}
                  <td className="pl-3 pr-1 py-1.5 text-right num font-mono text-ink bg-bg-elev/40">
                    {fmt(row.total)}
                  </td>
                  <td className="pl-1 pr-3 py-1.5 text-right num font-mono text-[11px] bg-bg-elev/40">
                    <Yoy current={row.total} prior={row.priorTotal} />
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-bg-elev/30">
                <td className="px-5 py-2 font-medium text-ink sticky left-0 bg-[#0A1622]">
                  Total
                </td>
                {result.months.map((m) => (
                  <Fragment key={m}>
                    <td
                      className="pl-3 pr-1 py-2 text-right num font-mono text-ink cursor-pointer hover:text-cyan"
                      onClick={() => drillTo({ month: m })}
                    >
                      {fmt(result.monthTotals[m] ?? 0)}
                    </td>
                    <td className="pl-1 pr-3 py-2 text-right num font-mono text-[11px]">
                      <Yoy current={result.monthTotals[m] ?? 0} prior={result.priorMonthTotals[m]} />
                    </td>
                  </Fragment>
                ))}
                <td className="pl-3 pr-1 py-2 text-right num font-mono text-cyan bg-bg-elev/60">
                  {fmt(result.grandTotal)}
                </td>
                <td className="pl-1 pr-3 py-2 text-right num font-mono text-[11px] bg-bg-elev/60">
                  <Yoy current={result.grandTotal} prior={result.priorGrandTotal} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </Card>
  )
}

/** Percent change against the same month (or same-day-to-date) last year. */
function Yoy({ current, prior }: { current: number; prior: number | undefined }) {
  if (prior == null || prior <= 0 || current <= 0) return <span className="text-ink-mute/40">—</span>
  const pct = ((current - prior) / prior) * 100
  const tone = pct >= 0 ? "text-grass" : "text-coral"
  return <span className={tone}>{pct >= 0 ? "+" : ""}{pct.toFixed(0)}%</span>
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
