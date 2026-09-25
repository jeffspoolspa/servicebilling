"use client"

import { Fragment, useState } from "react"
import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
import { workdays } from "@/lib/utils/workdays"
import type { RevenueKpis, KpiBucket, TrendPoint } from "@/lib/queries/revenue"

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
export function RevenueHero({ kpis, trend }: { kpis: RevenueKpis; trend: TrendPoint[] }) {
  const ref = new Date(kpis.reference_date + "T00:00:00Z")
  return (
    <section className="grid grid-cols-3 gap-3.5 items-stretch auto-rows-[minmax(300px,auto)]">
      <YearCompare year={ref.getUTCFullYear()} trend={trend} ytd={kpis.ytd} qtd={kpis.qtd} />
    </section>
  )
}

/**
 * Two cards sharing one hover. Left (two thirds): this year against last
 * year, month by month, one hue per month shared across both rows, with
 * ghost slices for the months not yet reached at this year's pace. Right:
 * the hovered month (default: the month in progress), its two slices lifted
 * out on their own scale, with the numbers. Everything is the daily
 * ledger's monthly totals; the month in progress compares to last year
 * through the same day.
 */
function YearCompare({ year, trend, ytd, qtd }: { year: number; trend: TrendPoint[]; ytd: KpiBucket; qtd: KpiBucket }) {
  const [hover, setHover] = useState<number | null>(null)
  const current = trend.findIndex((p) => p.partial) >= 0 ? trend.findIndex((p) => p.partial) : Math.max(0, trend.filter((p) => p.current != null).length - 1)
  const segments = segmentsBy(trend, "month")
  const priorTotal = segments.reduce((a, g) => a + g.prior, 0)
  const currentTotal = segments.reduce((a, g) => a + g.current, 0)

  const priorSameDay = ytd.prior_year ?? 0
  const pace = priorSameDay > 0 ? currentTotal / priorSameDay : 1
  const paceDelta = (pace - 1) * 100
  const daysLeft = ytd.workdays_total - ytd.workdays_elapsed
  // Per workday: this year so far, last year in full, and what the days left
  // must average to match last year's total.
  const workdaysPrior = workdays(`${year - 1}-01-01`, `${year}-01-01`)
  const perDay = ytd.per_workday
  const priorPerDay = workdaysPrior > 0 ? ytd.prior_full / workdaysPrior : 0
  const toGoTotal = ytd.prior_full - ytd.revenue
  const neededPerDay = daysLeft > 0 ? toGoTotal / daysLeft : null

  // Months not yet reached, projected at last year's amount x this year's pace
  // (the month in progress gets its remainder the same way). These draw as
  // ghost slices on the year bar so it runs out to the projected year end.
  const ghost = trend.map((p) => {
    if (p.current == null) return (p.prior ?? 0) * pace
    if (p.partial) return Math.max(0, ((p.prior ?? 0) - (p.prior_same_days ?? 0)) * pace)
    return 0
  })
  const projectedTotal = currentTotal + ghost.reduce((a, v) => a + v, 0)
  const scale = Math.max(priorTotal, projectedTotal) || 1
  const w = (v: number) => `${(v / scale) * 100}%`
  const wide = (v: number) => v / scale >= 0.05

  const sel = hover ?? current
  const tone = (d: number | null) => d == null ? "text-ink-mute" : d >= 0 ? "text-grass" : "text-coral"
  const pctStr = (d: number | null) => d == null ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`
  const monthLong = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" })

  const p = trend[sel]
  const cur = p.current ?? 0
  const pri = p.partial ? p.prior_same_days ?? 0 : p.prior ?? 0
  const mScale = Math.max(cur, pri) || 1
  const d = pri > 0 && p.current != null ? ((cur - pri) / pri) * 100 : null
  const hue = segments[sel].hue
  const label = segments[sel].label
  const diff = p.current != null && pri > 0 ? cur - pri : null
  const yy = (y: number) => `${label} '${String(y).slice(2)}`

  // The quarter holding the selected month. The quarter in progress compares
  // to last year through the same day (the QTD bucket); a finished quarter
  // compares whole to whole.
  const qi = Math.floor(sel / 3)
  const quarters = segmentsBy(trend, "quarter")
  const qCurrentQuarter = Math.floor(current / 3)
  const qPartial = qi === qCurrentQuarter && p.partial
  const qCur = quarters[qi].current
  const qPri = qPartial ? qtd.prior_year ?? 0 : quarters[qi].prior
  const qScale = Math.max(qCur, qPri) || 1
  const qD = qPri > 0 && qCur > 0 ? ((qCur - qPri) / qPri) * 100 : null
  const qDiff = qPri > 0 && qCur > 0 ? qCur - qPri : null
  const qHue = quarters[qi].hue
  const qLabel = `Q${qi + 1}`
  const qyy = (y: number) => `${qLabel} '${String(y).slice(2)}`
  const glow = "absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]"

  return (
    <>
      {/* ── The year ─────────────────────────────────────────────────── */}
      <Card className="relative overflow-hidden col-span-2">
        <div className={glow} />
        <CardBody className="h-full flex flex-col">
          <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
              Revenue <span className="text-ink-mute/60">· {year} vs {year - 1}</span>
            </div>
            <div className="text-[11px] font-mono tabular-nums text-ink-mute flex items-baseline gap-3">
              <span><span className="text-ink">{formatCompactCurrency(perDay)}</span>/day</span>
              <span>{year - 1} {formatCompactCurrency(priorPerDay)}/day</span>
              <span>
                {toGoTotal <= 0 || neededPerDay == null
                  ? <span className="text-grass">{formatCompactCurrency(-toGoTotal)} over</span>
                  : <><span className="text-cyan">{formatCompactCurrency(neededPerDay)}</span>/day needed</>}
              </span>
              <span>{daysLeft} left</span>
            </div>
          </div>

          <div className="flex-1 flex flex-col justify-center gap-5 py-4 text-[12px] font-mono tabular-nums whitespace-nowrap" onMouseLeave={() => setHover(null)}>
            {[
              { row: String(year), values: segments.map((g) => g.current), amount: currentTotal, strong: true },
              { row: String(year - 1), values: segments.map((g) => g.prior), amount: priorTotal, strong: false },
            ].map((r, ri) => (
              <div key={r.row} className="flex items-center gap-3">
                <span className="w-10 text-ink-mute">{r.row}</span>
                <div className="flex-1 h-14 rounded-md bg-white/[0.06] overflow-hidden flex gap-px">
                  {segments.map((g, i) => (
                    <Fragment key={g.label}>
                      {r.values[i] > 0 && (
                        <div
                          onMouseEnter={() => setHover(i)}
                          className={`h-full flex items-center justify-center text-[11px] leading-none overflow-hidden cursor-default transition-opacity ${sel === i ? "text-[#0A1622] font-medium" : "text-white/70 opacity-60"}`}
                          style={{ width: w(r.values[i]), background: seg(g.hue, sel === i) }}
                          title={`${g.label} ${formatCompactCurrency(r.values[i])}`}
                        >
                          {wide(r.values[i]) ? g.label : ""}
                        </div>
                      )}
                      {ri === 0 && ghost[i] > 0 && (
                        // placeholder: this month at last year's amount x this year's pace
                        <div
                          onMouseEnter={() => setHover(i)}
                          className="h-full flex items-center justify-center text-[10px] leading-none overflow-hidden cursor-default text-white/40"
                          style={{ width: w(ghost[i]), background: `repeating-linear-gradient(135deg, ${seg(g.hue, false)} 0 3px, transparent 3px 6px)`, opacity: 0.6 }}
                          title={`${g.label} at this pace: ${formatCompactCurrency(ghost[i])}`}
                        >
                          {wide(ghost[i]) ? g.label : ""}
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
                <span className={`w-16 text-right ${r.strong ? "text-ink" : "text-ink-dim"}`} title={ri === 0 ? `booked ${formatCompactCurrency(currentTotal)} + projected` : undefined}>
                  {formatCompactCurrency(ri === 0 ? projectedTotal : r.amount)}
                </span>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-line-soft flex items-baseline justify-between gap-3 text-[12px] font-mono tabular-nums whitespace-nowrap">
            <span className="text-ink-mute"><span className="text-ink">{formatCompactCurrency(currentTotal)}</span> YTD · {((currentTotal / (priorTotal || 1)) * 100).toFixed(0)}% of {year - 1}</span>
            <span className="text-ink-mute"><span className={tone(paceDelta)}>{pctStr(paceDelta)}</span> · <span className={priorTotal - currentTotal > 0 ? "text-ink" : "text-grass"}>{formatCompactCurrency(Math.abs(priorTotal - currentTotal))} {priorTotal - currentTotal > 0 ? "to go" : "over"}</span></span>
          </div>
        </CardBody>
      </Card>

      {/* ── The month, then its quarter: number left, the two slices beside it ── */}
      <Card className="relative overflow-hidden">
        <div className={glow} />
        <CardBody className="h-full flex flex-col">
          <Block
            title="Month" sub={`${monthLong(p.month)}${p.partial ? " so far" : ""}`}
            value={p.current == null ? "—" : formatCompactCurrency(cur)}
            diff={diff} pct={d} priorYear={year - 1}
            rows={[
              { label: yy(year), v: cur, lit: true, amount: p.current == null ? "—" : formatCompactCurrency(cur), strong: true },
              { label: yy(year - 1), v: pri, lit: false, amount: formatCompactCurrency(pri), strong: false },
            ]}
            scale={mScale} hue={hue} tone={tone} pctStr={pctStr}
          />
          <div className="border-t border-line-soft" />
          <Block
            title="Quarter" sub={`${qLabel}${qPartial ? " so far" : ""}`}
            value={qCur > 0 ? formatCompactCurrency(qCur) : "—"}
            diff={qDiff} pct={qD} priorYear={year - 1}
            rows={[
              { label: qyy(year), v: qCur, lit: true, amount: qCur > 0 ? formatCompactCurrency(qCur) : "—", strong: true },
              { label: qyy(year - 1), v: qPri, lit: false, amount: formatCompactCurrency(qPri), strong: false },
            ]}
            scale={qScale} hue={qHue} tone={tone} pctStr={pctStr}
          />
        </CardBody>
      </Card>
    </>
  )
}

/** A period block: title, the number with its difference on the left, the two slices beside it. */
function Block({ title, sub, value, diff, pct, priorYear, rows, scale, hue, tone, pctStr }: {
  title: string
  sub: string
  value: string
  diff: number | null
  pct: number | null
  priorYear: number
  rows: Array<{ label: string; v: number; lit: boolean; amount: string; strong: boolean }>
  scale: number
  hue: number
  tone: (d: number | null) => string
  pctStr: (d: number | null) => string
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col justify-center">
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute whitespace-nowrap">
        {title} <span className="text-ink-mute/60">· {sub}</span>
      </div>
      <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4">
        <div>
          <div className="font-sans num text-[32px] font-semibold tracking-tight text-ink leading-none">{value}</div>
          <div className="mt-1.5 text-[11px] font-mono tabular-nums whitespace-nowrap">
            <span className={tone(pct)}>{diff == null ? "—" : `${diff >= 0 ? "+" : "-"}${formatCompactCurrency(Math.abs(diff))}`}</span>
            <span className={`ml-2 ${tone(pct)}`}>{pctStr(pct)}</span>
            <span className="text-ink-mute"> vs {priorYear}</span>
          </div>
        </div>
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-2 text-[11px] font-mono tabular-nums whitespace-nowrap">
          {rows.map((r) => (
            <Fragment key={r.label}>
              <span className="text-ink-mute">{r.label}</span>
              <div className="h-5 rounded-sm bg-white/[0.06] overflow-hidden">
                <div className="h-full" style={{ width: `${(r.v / scale) * 100}%`, background: seg(hue, r.lit) }} />
              </div>
              <span className={`text-right w-14 ${r.strong ? "text-ink" : "text-ink-dim"}`}>{r.amount}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

interface Segment { label: string; current: number; prior: number; hue: number }

// One hue per calendar slot, shared by both years so Sep lines up with Sep.
// Months walk the color wheel; quarters take every third stop.
const MONTH_HUE = [200, 225, 250, 280, 310, 340, 10, 30, 50, 80, 120, 160]
const seg = (hue: number, lit: boolean) =>
  `hsl(${hue} ${lit ? 65 : 30}% ${lit ? 58 : 42}% / ${lit ? 1 : 0.55})`

/** The year split into months or quarters, both years, from the trend's monthly totals. */
function segmentsBy(trend: TrendPoint[], by: "month" | "quarter"): Segment[] {
  if (by === "month") {
    return trend.map((p, i) => ({
      label: new Date(p.month + "T00:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      current: p.current ?? 0,
      prior: p.prior ?? 0,
      hue: MONTH_HUE[i],
    }))
  }
  return [0, 1, 2, 3].map((qi) => ({
    label: `Q${qi + 1}`,
    current: trend.slice(qi * 3, qi * 3 + 3).reduce((a, p) => a + (p.current ?? 0), 0),
    prior: trend.slice(qi * 3, qi * 3 + 3).reduce((a, p) => a + (p.prior ?? 0), 0),
    hue: MONTH_HUE[qi * 3 + 1],
  }))
}

