"use client"

import { OptionPills } from "@/components/ui/option-pills"
import type { Office } from "@/lib/routing/infrastructure/offices"

/**
 * Multi-select office scope. Offices are fetched (listOffices), never hard-coded,
 * and an empty selection means all — so a new branch appears here on its own.
 * Counts are whatever the caller is scoping; the filter does not compute them.
 */
export function OfficeFilter({
  offices,
  value,
  onChange,
  counts,
  size = "md",
}: {
  offices: Office[]
  value: string[]
  onChange: (labels: string[]) => void
  counts?: Record<string, number>
  size?: "sm" | "md"
}) {
  return (
    <OptionPills
      multiple
      allLabel="All offices"
      size={size}
      value={value}
      onChange={onChange}
      options={offices.map((o) => ({
        value: o.label,
        label: o.label,
        count: counts?.[o.label],
      }))}
    />
  )
}
