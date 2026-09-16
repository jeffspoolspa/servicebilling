"use client"

import { useCallback, useState, useTransition } from "react"
import type {
  Dimension,
  Measure,
  PivotResult,
} from "@/lib/queries/revenue"
import { RevenuePivot } from "./revenue-pivot"
import { yearRange } from "@/lib/utils/year-range"

/**
 * Thin client wrapper that owns the pivot's filter state (dimension,
 * measure, year) and re-fetches the pivot on change. A year is always
 * the full Jan..Dec range; months not yet reached simply have no rows.
 *
 * The trend chart used to live here too but now sits as its own card on
 * the dashboard, decoupled from the pivot's dimension/measure controls.
 */

interface Props {
  initialPivot: PivotResult
  initialDimension: Dimension
  initialMeasure: Measure
  initialYear: number
  years: number[]
}

export function RevenueAnalysis({
  initialPivot,
  initialDimension,
  initialMeasure,
  initialYear,
  years,
}: Props) {
  const [dimension, setDimension] = useState<Dimension>(initialDimension)
  const [measure, setMeasure] = useState<Measure>(initialMeasure)
  const [year, setYear] = useState(initialYear)
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
    refetch({ dimension: d, measure, ...yearRange(year) })
  }

  const handleMeasure = (m: Measure) => {
    setMeasure(m)
    refetch({ dimension, measure: m, ...yearRange(year) })
  }

  const handleYear = (y: number) => {
    setYear(y)
    refetch({ dimension, measure, ...yearRange(y) })
  }

  return (
    <RevenuePivot
      result={pivot}
      dimension={dimension}
      measure={measure}
      year={year}
      years={years}
      pending={pending}
      onDimensionChange={handleDimension}
      onMeasureChange={handleMeasure}
      onYearChange={handleYear}
    />
  )
}
