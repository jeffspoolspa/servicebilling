"use client"

/** Shared bits for the ServiceLog summary charts. */

export interface ChartRow {
  iso: string   // YYYY-MM-DD
  date: string
  fc: number | null
  min: number | null
  lsi: number | null
}

export function ChartEmpty({ title }: { title: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">{title}</div>
      <div className="h-[130px] grid place-items-center text-[10px] text-ink-mute border border-dashed border-line rounded">
        insufficient data
      </div>
    </div>
  )
}
