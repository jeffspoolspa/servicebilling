"use client"

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import type { Dimension, Measure, PivotResult } from "@/lib/queries/revenue"
import { TECH_OTHER_BUCKET } from "@/lib/queries/revenue"

/**
 * Breakdown pivot — star of the Service Dashboard. This is a controlled
 * component: filter state (dimension / measure / range) lives in the
 * parent <RevenueAnalysis> wrapper so the trend strip below stays in
 * lockstep. The pivot surfaces the controls + the table, but emits
 * changes via callbacks.
 *
 * Drilldown paths — every click navigates to /work-orders with filters:
 *   - Month column header → ?month=YYYY-MM
 *   - Row label           → ?<dim>=<value>
 *   - Cell                → ?<dim>=<value>&month=YYYY-MM
 *   - "Other departments" row (tech view) → ?tech_other=1 (synthetic bucket)
 */

const DATE_PRESETS: Array<{
  key: "3m" | "6m" | "12m" | "ytd"
  label: string
}> = [
  { key: "3m", label: "Last 3 months" },
  { key: "6m", label: "Last 6 months" },
  { key: "12m", label: "Last 12 months" },
  { key: "ytd", label: "YTD" },
]

export type Preset = (typeof DATE_PRESETS)[number]["key"]

interface Props {
  result: PivotResult
  dimension: Dimension
  measure: Measure
  range: { startMonth: string; endMonth: string; preset: Preset }
  pending: boolean
  onDimensionChange: (d: Dimension) => void
  onMeasureChange: (m: Measure) => void
  /** Parent receives just the new preset; it owns the mapping from
   *  preset → concrete startMonth/endMonth. Keeps this component
   *  presentational and avoids an export-soup fast-refresh warning. */
  onPresetChange: (p: Preset) => void
}

export function RevenuePivot({
  result,
  dimension,
  measure,
  range,
  pending,
  onDimensionChange,
  onMeasureChange,
  onPresetChange,
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
              { value: "department", label: "Department" },
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
          <DateRangePicker value={range.preset} onChange={onPresetChange} />
        </div>
      </CardHeader>

      <div className="overflow-x-auto relative">
        {pending && (
          <div className="absolute inset-0 bg-bg-elev/40 pointer-events-none z-10" />
        )}

        {result.rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-ink-mute text-sm">
            No revenue in the selected range.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
                <th className="px-5 py-2.5 font-medium sticky left-0 bg-bg-elev">
                  {dimension === "location"
                    ? "Location"
                    : dimension === "tech"
                      ? "Tech"
                      : "Department"}
                </th>
                {result.months.map((m) => (
                  <th
                    key={m}
                    className="px-3 py-2.5 font-medium text-right num cursor-pointer hover:text-cyan transition-colors"
                    onClick={() => drillTo({ month: m })}
                    title={`Open work orders invoiced in ${monthLabel(m, true)}`}
                  >
                    {monthLabel(m)}
                  </th>
                ))}
                <th className="px-3 py-2.5 font-medium text-right num bg-bg-elev/60">
                  Total
                </th>
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
                      <td
                        key={m}
                        className={`px-3 py-1.5 text-right num font-mono ${
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
                    )
                  })}
                  <td className="px-3 py-1.5 text-right num font-mono text-ink bg-bg-elev/40">
                    {fmt(row.total)}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-line bg-bg-elev/30">
                <td className="px-5 py-2 font-medium text-ink sticky left-0 bg-[#0A1622]">
                  Total
                </td>
                {result.months.map((m) => (
                  <td
                    key={m}
                    className="px-3 py-2 text-right num font-mono text-ink cursor-pointer hover:text-cyan"
                    onClick={() => drillTo({ month: m })}
                  >
                    {fmt(result.monthTotals[m] ?? 0)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right num font-mono text-cyan bg-bg-elev/60">
                  {fmt(result.grandTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </Card>
  )
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

function DateRangePicker({
  value,
  onChange,
}: {
  value: Preset
  onChange: (v: Preset) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Preset)}
      className="bg-bg-elev border border-line rounded-md px-2 py-1 text-[11px] text-ink"
    >
      {DATE_PRESETS.map((p) => (
        <option key={p.key} value={p.key}>
          {p.label}
        </option>
      ))}
    </select>
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
