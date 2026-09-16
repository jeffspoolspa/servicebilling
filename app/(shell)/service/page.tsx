import { ObjectHeader } from "@/components/shell/object-header"
import { BarChart3 } from "lucide-react"
import {
  getRevenueKpis,
  getRevenueTrend,
  getRevenueBreakdown,
  defaultDateRange,
} from "@/lib/queries/revenue"
import {
  getMonthlyBonuses,
  currentMonthIso,
} from "@/lib/queries/bonuses"
import { RevenueHero } from "@/components/dashboard/revenue-hero"
import { RevenueTrendChart } from "@/components/dashboard/revenue-trend-chart"
import { RevenueAnalysis } from "@/components/dashboard/revenue-analysis"
import { MonthlyBonusesCard } from "@/components/dashboard/monthly-bonuses-card"

export const dynamic = "force-dynamic"

/**
 * Service Dashboard — the landing page of the Service module.
 *
 *   1. Hero KPIs (MTD / QTD / YTD with YoY)
 *   2. Two-column row:
 *      - Left: revenue trend, this year vs last year, Jan..Dec
 *      - Right: Monthly Bonuses card (five bonus-eligible techs)
 *   3. Breakdown pivot — full width, with dimension/measure/range toggles.
 *      Click any cell / row / column to drill into /work-orders.
 */
export default async function ServicePage() {
  const range = defaultDateRange()
  // Trend is the current calendar year, Jan..Dec, with last year overlaid
  // (independent of the pivot's configurable range).
  const trendRange = calendarYearRange()
  const now = new Date()
  const initialBonusMonth = currentMonthIso(now)

  const [kpis, trend, initialBreakdown, initialBonuses] = await Promise.all([
    getRevenueKpis(now),
    getRevenueTrend(trendRange),
    getRevenueBreakdown({
      dimension: "location",
      measure: "revenue",
      ...range,
    }),
    getMonthlyBonuses(initialBonusMonth),
  ])

  return (
    <>
      <ObjectHeader
        eyebrow="Service · Live"
        title="Revenue overview"
        sub="Billable work orders invoiced in QBO, broken out by location, tech, and department. Click any cell to drill into the work orders behind it."
        icon={<BarChart3 className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 flex flex-col gap-6">
        <RevenueHero kpis={kpis} />

        <div className="grid grid-cols-2 gap-5">
          <RevenueTrendChart data={trend} />
          <MonthlyBonusesCard initial={initialBonuses} />
        </div>

        <RevenueAnalysis
          initialPivot={initialBreakdown}
          initialDimension="location"
          initialMeasure="revenue"
          initialRange={{ ...range, preset: "6m" }}
        />
      </div>
    </>
  )
}

function calendarYearRange(
  now: Date = new Date(),
): { startMonth: string; endMonth: string } {
  const y = now.getUTCFullYear()
  return { startMonth: `${y}-01-01`, endMonth: `${y + 1}-01-01` }
}
