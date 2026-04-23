"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { ChevronRight, Info } from "lucide-react"
import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import {
  recentMonths,
  ZACH_TECH,
  type MonthlyBonusesResult,
} from "@/lib/queries/bonuses"

/**
 * Monthly Bonuses card — right-side companion to the revenue trend on
 * the Service Dashboard.
 *
 * Lists the five bonus-eligible techs with their computed bonus for the
 * selected month. Month picker defaults to the current month; fetches
 * fresh data on change via /api/service/bonuses.
 *
 * Each row links to /work-orders with filters preset so the user can
 * see exactly which WOs made up that bonus.
 */

interface Props {
  initial: MonthlyBonusesResult
}

export function MonthlyBonusesCard({ initial }: Props) {
  const [month, setMonth] = useState(initial.month)
  const [data, setData] = useState(initial)
  const [pending, startTransition] = useTransition()

  // 12 months of options, most recent first. Options are computed at
  // mount time rather than on each render so the select remains stable.
  const [options] = useState<string[]>(() => recentMonths(12))

  const refetch = useCallback((m: string) => {
    startTransition(async () => {
      const resp = await fetch("/api/service/bonuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: m }),
      })
      if (!resp.ok) return
      setData((await resp.json()) as MonthlyBonusesResult)
    })
  }, [])

  useEffect(() => {
    if (month === initial.month) return
    refetch(month)
  }, [month, initial.month, refetch])

  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-line-soft text-[11px]">
        <span className="uppercase tracking-[0.14em] text-ink-mute font-medium">
          Monthly Bonuses
        </span>
        <span className="ml-auto">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="bg-bg-elev border border-line rounded-md px-2 py-1 text-[11px] text-ink focus:outline-none focus:border-cyan"
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {monthLabelLong(m)}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="px-5 py-3 border-b border-line-soft flex items-center gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Total Payout
          </div>
          <div className="font-mono tabular-nums text-[22px] text-ink mt-0.5">
            {formatCurrency(data.total_bonus)}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Eligible Revenue
          </div>
          <div className="font-mono tabular-nums text-[12px] text-ink-dim mt-0.5">
            {formatCurrency(data.total_eligible_revenue)}
          </div>
        </div>
      </div>

      <div
        className={
          "flex-1 divide-y divide-line-soft relative" +
          (pending ? " opacity-60" : "")
        }
      >
        {data.entries.map((e) => {
          // Zach's bonus is indexed to the CTA group — drilling into him
          // shows the THREE techs (Chance + Travis + Aaron) that make up
          // his base, not Zach himself (he has no bonus-eligible WOs).
          const isZach = e.tech === ZACH_TECH
          const href = isZach
            ? (`/work-orders?cta_group=1&month=${month}&bonus=true` as never)
            : (`/work-orders?tech=${encodeURIComponent(e.tech)}&month=${month}&bonus=true` as never)
          return (
          <Link
            key={e.tech}
            href={href}
            className="flex items-center gap-3 px-5 py-2.5 hover:bg-white/[0.03] transition-colors group"
            title={
              e.note
                ? `${e.displayName} — ${e.note}`
                : `Open the ${e.wos} WO${e.wos === 1 ? "" : "s"} behind this bonus`
            }
          >
            <div className="min-w-0 flex-1">
              <div className="text-ink text-[13px] flex items-center gap-1.5">
                {e.displayName}
                {e.note && (
                  <Info
                    className="w-3 h-3 text-ink-mute"
                    strokeWidth={1.8}
                  />
                )}
              </div>
              <div className="text-[10px] text-ink-mute font-mono tabular-nums">
                {formatCurrency(e.base)} × {(e.rate * 100).toFixed(2)}%
                {e.wos > 0 && (
                  <>
                    {" "}· {e.wos} WO{e.wos === 1 ? "" : "s"}
                  </>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono tabular-nums text-[15px] text-ink">
                {formatCurrency(e.bonus)}
              </div>
            </div>
            <ChevronRight
              className="w-3.5 h-3.5 text-ink-mute opacity-0 group-hover:opacity-100 transition-opacity"
              strokeWidth={2}
            />
          </Link>
          )
        })}
      </div>
    </Card>
  )
}

function monthLabelLong(iso: string): string {
  const d = new Date(`${iso}-01T00:00:00Z`)
  return d.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}
