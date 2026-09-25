import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import type { RevenueKpis, KpiBucket } from "@/lib/queries/revenue"

/**
 * Hero row: month, quarter, year, all in one format. Two horizontal bars on
 * one scale: last year's full period (100%), and this period as booked
 * so far plus a lighter segment for the rest of the period at this
 * period's pace. Everything is a percentage of last year, so it updates
 * itself daily:
 *   share    = last year's revenue by this day / last year's period total
 *   pace     = this period's revenue by this day / last year's by this day
 *   landing  = pace x 100%  (= booked / share)
 * The label is landing - 100%. No even-calendar assumption, and a weak
 * period is not assumed to recover on its own.
 */
export function RevenueHero({ kpis }: { kpis: RevenueKpis }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  const year = ref.getUTCFullYear()
  const q = Math.floor(ref.getUTCMonth() / 3)
  const short = (m: number) =>
    new Date(Date.UTC(year, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const month = short(ref.getUTCMonth())
  const quarterMonths = `${short(q * 3)}–${short(q * 3 + 2)}`

  return (
    <section className="grid grid-cols-3 gap-3.5">
      <Tile label="Month" period={month} thisLabel={month} priorLabel={`${month} '${String(year - 1).slice(2)}`} bucket={kpis.mtd} />
      <Tile label="Quarter" period={quarterMonths} thisLabel={`Q${q + 1}`} priorLabel={`Q${q + 1} '${String(year - 1).slice(2)}`} bucket={kpis.qtd} />
      <Tile label="Year" period={String(year)} thisLabel={String(year)} priorLabel={String(year - 1)} bucket={kpis.ytd} />
    </section>
  )
}

function Tile({ label, period, thisLabel, priorLabel, bucket }: {
  label: string
  period: string
  thisLabel: string
  priorLabel: string
  bucket: KpiBucket
}) {
  const prior = bucket.prior_full
  const booked = bucket.revenue
  const priorSameDay = bucket.prior_year ?? 0
  const hasPrior = prior > 0 && priorSameDay > 0
  const pace = hasPrior ? booked / priorSameDay : 1          // this period vs last, same days
  const bookedPct = prior > 0 ? (booked / prior) * 100 : 0     // of last year's period total
  const landingPct = hasPrior ? pace * 100 : bookedPct         // where this pace lands
  const restPct = Math.max(0, landingPct - bookedPct)
  const projected = hasPrior ? prior * pace : booked
  const delta = hasPrior ? landingPct - 100 : null
  const ahead = (delta ?? 0) >= 0
  const scale = Math.max(100, landingPct) || 100
  const w = (pct: number) => `${(pct / scale) * 100}%`
  const daysLeft = bucket.workdays_total - bucket.workdays_elapsed
  const done = daysLeft <= 0

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            {label} <span className="text-ink-mute/60">· {period}</span>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-ink-mute">
            {daysLeft} workday{daysLeft === 1 ? "" : "s"} left
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-3 mt-2.5 whitespace-nowrap">
          <div className="font-sans num text-[34px] font-semibold tracking-tight text-ink leading-none">
            {formatCompactCurrency(booked)}
          </div>
          {delta != null ? (
            <div className={`font-mono tabular-nums text-[13px] ${ahead ? "text-grass" : "text-coral"}`}>
              {ahead ? "+" : ""}{delta.toFixed(1)}% <span className="text-ink-mute">{done ? "vs last yr" : "pace"}</span>
            </div>
          ) : (
            <div className="font-mono text-[11px] text-ink-mute">no prior-year baseline</div>
          )}
        </div>

        <div className="mt-3 space-y-1.5 text-[11px] font-mono tabular-nums whitespace-nowrap">
          <div className="flex items-center gap-2">
            <span className="w-12 text-ink-mute truncate">{thisLabel}</span>
            <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden flex">
              <div className="h-full bg-cyan" style={{ width: w(bookedPct) }}
                title={`Booked so far: ${bookedPct.toFixed(0)}% of ${priorLabel} (${formatCompactCurrency(booked)})`} />
              <div className={`h-full ${ahead ? "bg-grass/45" : "bg-coral/45"}`} style={{ width: w(restPct) }}
                title={`Rest of ${label.toLowerCase()} at this pace: +${restPct.toFixed(0)}%, landing at ${landingPct.toFixed(0)}% (${formatCompactCurrency(projected)})`} />
            </div>
            <span className="w-9 text-right text-ink">{bookedPct.toFixed(0)}%</span>
            <span className="w-14 text-right text-ink-dim">{formatCompactCurrency(booked)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-ink-mute truncate">{priorLabel}</span>
            <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-ink/45" style={{ width: w(100) }} />
            </div>
            <span className="w-9 text-right text-ink-dim">100%</span>
            <span className="w-14 text-right text-ink-dim">{formatCompactCurrency(prior)}</span>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-3 text-[10px] font-mono text-ink-mute whitespace-nowrap">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-[2px] bg-cyan" />booked</span>
          <span className="flex items-center gap-1"><span className={`inline-block w-2 h-2 rounded-[2px] ${ahead ? "bg-grass/45" : "bg-coral/45"}`} />rest of {label.toLowerCase()} at this pace</span>
        </div>
      </CardBody>
    </Card>
  )
}
