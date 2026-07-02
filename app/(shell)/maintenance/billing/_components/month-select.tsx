"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

/** Month dropdown that navigates via the `month` search param (URL-driven, no state). */
export function MonthSelect({
  months,
  value,
}: {
  months: { value: string; label: string }[]
  value: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  return (
    <select
      value={value}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString())
        next.set("month", e.target.value)
        router.replace(`${pathname}?${next.toString()}` as never)
      }}
      className="bg-bg-elev border border-line rounded px-2.5 py-1.5 text-[13px] text-ink"
    >
      {months.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  )
}
