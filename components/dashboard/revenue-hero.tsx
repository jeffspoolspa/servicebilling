import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket } from "@/lib/queries/revenue"

/**
 * Hero row of three goal trackers — month, quarter, year. Each works like a
 * fundraising thermometer:
 *
 *   goal    = what the same period brought in last year, in full
 *   bar     = vertical, beside the number: revenue booked so far this
 *             period as a share of that goal, filling from the bottom
 *   verdict = dollars still to go, or dollars over once the goal is passed,
 *             and the workdays left to get there
 *
 * No pace judgement: the tile states the total and where we stand against
 * it. Cyan while under the goal, green once it is met. The bar caps
 * visually at 100% but the percentage keeps counting.
 */
export function RevenueHero({ kpis }: { kpis: RevenueKpis }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  const year = ref.getUTCFullYear()
  const q = Math.floor(ref.getUTCMonth() / 3)
  const short = (m: number) =>
    new Date(Date.UTC(year, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const month = short(ref.getUTCMonth())
  const quarterMonths = [0, 1, 2].map((i) => short(q * 3 + i)).join(" ")

  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="Month" period={month} goalLabel={`${month} ${year - 1}`} bucket={kpis.mtd} />
      <Tile label="Quarter" period={quarterMonths} goalLabel={`Q${q + 1} ${year - 1}`} bucket={kpis.qtd} />
      <Tile label="Year" period={String(year)} goalLabel={String(year - 1)} bucket={kpis.ytd} />
    </section>
  )
}

function Tile({ label, period, goalLabel, bucket }: {
  label: string
  period: string
  goalLabel: string
  bucket: KpiBucket
}) {
  const goal = bucket.prior_full
  const hasGoal = goal > 0
  const toGo = goal - bucket.revenue
  const met = hasGoal && toGo <= 0
  const pct = hasGoal ? (bucket.revenue / goal) * 100 : 0
  const daysLeft = bucket.workdays_total - bucket.workdays_elapsed
  const tone = met ? "text-grass" : "text-ink-dim"
  const barTone = met ? "bg-grass" : "bg-cyan"

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          {label} <span className="text-ink-mute/60">· {period}</span>
        </div>

        <div className="flex items-stretch justify-between gap-5 mt-2">
          {/* Where we are */}
          <div className="flex flex-col justify-between min-w-0">
            <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
              {formatCompactCurrency(bucket.revenue)}
            </div>
            <div className="mt-3 text-[11px] font-mono tabular-nums">
              <div className={tone}>
                {!hasGoal
                  ? "no prior-year total"
                  : met
                    ? `${formatCompactCurrency(-toGo)} over`
                    : `${formatCompactCurrency(toGo)} to go`}
              </div>
              <div className="text-ink-mute mt-0.5">
                {daysLeft} workday{daysLeft === 1 ? "" : "s"} left
              </div>
            </div>
          </div>

          {/* The goal, as a thermometer */}
          <div className="flex items-stretch gap-2.5 shrink-0">
            <div className="flex flex-col text-right text-[11px] font-mono tabular-nums">
              <div>
                <div className="text-ink-mute">{goalLabel}</div>
                <div className="text-ink-dim">{hasGoal ? formatCompactCurrency(goal) : "—"}</div>
              </div>
            </div>
            <div
              className="relative w-6 min-h-[76px] rounded-md bg-white/[0.07] border border-line overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, pct))}
              aria-label={`${label} revenue against ${goalLabel}`}
            >
              <div
                className={`absolute inset-x-0 bottom-0 ${barTone}`}
                style={{ height: `${Math.min(100, pct)}%` }}
              />
              {/* quarter marks so the fill level reads at a glance */}
              {[25, 50, 75].map((t) => (
                <div key={t} className="absolute inset-x-0 h-px bg-bg/50" style={{ bottom: `${t}%` }} />
              ))}
            </div>
            {/* the percentage rides beside the fill line */}
            <div className="relative w-9 text-[12px] font-mono tabular-nums">
              {hasGoal && (
                <div
                  className={`absolute left-0 translate-y-1/2 ${met ? "text-grass" : "text-ink"}`}
                  style={{ bottom: `${Math.max(8, Math.min(92, pct))}%` }}
                >
                  {pct.toFixed(0)}%
                </div>
              )}
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
