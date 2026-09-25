import { ObjectHeader } from "@/components/shell/object-header"
import { BarChart3 } from "lucide-react"
import {
  getServiceDaily,
  revenueKpis,
  revenueTrend,
  dailyMap,
  getRevenueBreakdown,
} from "@/lib/queries/revenue"
import {
  getMonthlyBonuses,
  currentMonthIso,
} from "@/lib/queries/bonuses"
import { RevenueHero } from "@/components/dashboard/revenue-hero"
import { RevenueTrendChart } from "@/components/dashboard/revenue-trend-chart"
import { RevenueAnalysis } from "@/components/dashboard/revenue-analysis"
import { yearRange } from "@/lib/utils/year-range"
import { MonthlyBonusesCard } from "@/components/dashboard/monthly-bonuses-card"

export const dynamic = "force-dynamic"

/**
 * Service Dashboard — the landing page of the Service module.
 *
 *   1. Hero KPIs (MTD / QTD / YTD with YoY)
 *   2. Two-column row:
 *      - Left: monthly revenue, this year vs last year, Jan..Dec, eased by day
 *      - Right: Monthly Bonuses card (five bonus-eligible techs)
 *   3. Breakdown pivot — full width, one calendar year at a time, with
 *      dimension/measure toggles and a year picker.
 *      Click any cell / row / column to drill into /work-orders.
 */
export default async function ServicePage() {
  // Trend is the current calendar year, Jan..Dec, with last year overlaid
  // (independent of the pivot's configurable range).
  const now = new Date()
  const initialBonusMonth = currentMonthIso(now)

  const [ledger, initialBreakdown, initialBonuses] = await Promise.all([
    getServiceDaily(now.getUTCFullYear()),
    getRevenueBreakdown({
      dimension: "location",
      measure: "revenue",
      ...yearRange(now.getUTCFullYear()),
    }),
    getMonthlyBonuses(initialBonusMonth),
  ])
  // One daily ledger feeds the tiles, the trend, and the hover.
  const kpis = revenueKpis(ledger, now)
  const trend = revenueTrend(ledger, now.getUTCFullYear(), now)
  const daily = dailyMap(ledger)

  return (
    <>
      <ObjectHeader
        eyebrow="Service · Live"
        title="Revenue overview"
        sub="Service-class revenue by location and tech. Click any cell to drill into the work orders behind it."
        icon={<BarChart3 className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 flex flex-col gap-6">
        <RevenueHero kpis={kpis} trend={trend} />

        <div className="grid grid-cols-2 gap-5">
          <RevenueTrendChart data={trend} daily={daily} today={now.toISOString().slice(0, 10)} ytd={kpis.ytd} />
          <MonthlyBonusesCard initial={initialBonuses} />
        </div>

        <RevenueAnalysis
          initialPivot={initialBreakdown}
          initialDimension="location"
          initialMeasure="revenue"
          initialYear={now.getUTCFullYear()}
          years={selectableYears(now.getUTCFullYear())}
        />
      </div>
    </>
  )
}

// Work-order history in the revenue view starts in 2019 (the mirror
// backfill). Newest first for the picker.
const FIRST_YEAR = 2019
function selectableYears(current: number): number[] {
  const out: number[] = []
  for (let y = current; y >= FIRST_YEAR; y--) out.push(y)
  return out
}
