"use client"

import { useCallback, useState, useTransition } from "react"
import type {
  Dimension,
  Measure,
  PivotResult,
} from "@/lib/queries/revenue"
import { RevenuePivot, type Preset } from "./revenue-pivot"

/**
 * Thin client wrapper that owns the pivot's filter state (dimension,
 * measure, date range) and re-fetches the pivot on change.
 *
 * The trend chart used to live here too but now sits as its own card on
 * the dashboard, decoupled from the pivot's dimension/measure controls.
 */

interface Props {
  initialPivot: PivotResult
  initialDimension: Dimension
  initialMeasure: Measure
  initialRange: { startMonth: string; endMonth: string; preset: Preset }
}

export function RevenueAnalysis({
  initialPivot,
  initialDimension,
  initialMeasure,
  initialRange,
}: Props) {
  const [dimension, setDimension] = useState<Dimension>(initialDimension)
  const [measure, setMeasure] = useState<Measure>(initialMeasure)
  const [range, setRange] = useState(initialRange)
  const [pivot, setPivot] = useState<PivotResult>(initialPivot)
  const [pending, startTransition] = useTransition()

  const refetch = useCallback(
    (opts: {
      dimension: Dimension
      measure: Measure
      startMonth: string
      endMonth: string
    }) => {
      startTransition(async () => {
        const resp = await fetch("/api/service/revenue/pivot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        })
        if (!resp.ok) return
        const data = (await resp.json()) as PivotResult
        setPivot(data)
      })
    },
    [],
  )

  const handleDimension = (d: Dimension) => {
    setDimension(d)
    refetch({
      dimension: d,
      measure,
      startMonth: range.startMonth,
      endMonth: range.endMonth,
    })
  }

  const handleMeasure = (m: Measure) => {
    setMeasure(m)
    refetch({
      dimension,
      measure: m,
      startMonth: range.startMonth,
      endMonth: range.endMonth,
    })
  }

  const handlePreset = (preset: Preset) => {
    const { startMonth, endMonth } = computeRangeFromPreset(preset)
    setRange({ startMonth, endMonth, preset })
    refetch({ dimension, measure, startMonth, endMonth })
  }

  return (
    <RevenuePivot
      result={pivot}
      dimension={dimension}
      measure={measure}
      range={range}
      pending={pending}
      onDimensionChange={handleDimension}
      onMeasureChange={handleMeasure}
      onPresetChange={handlePreset}
    />
  )
}

function computeRangeFromPreset(
  preset: Preset,
  ref: Date = new Date(),
): { startMonth: string; endMonth: string } {
  const endMonth = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1),
  )
  const start = (() => {
    if (preset === "ytd") return new Date(Date.UTC(ref.getUTCFullYear(), 0, 1))
    const n = preset === "3m" ? 3 : preset === "6m" ? 6 : 12
    return new Date(
      Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - (n - 1), 1),
    )
  })()
  return {
    startMonth: start.toISOString().slice(0, 10),
    endMonth: endMonth.toISOString().slice(0, 10),
  }
}
