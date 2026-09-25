"use client"

import { Fragment, useState } from "react"
import { Card, CardBody } from "@/components/ui/card"
import { formatCompactCurrency } from "@/lib/utils/format"
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
  const year = ref.getUTCFullYear()

  return (
    <section className="grid grid-cols-3 gap-3.5">
      <div className="col-span-2">
        <YearCompare year={year} trend={trend} ytd={kpis.ytd} />
      </div>
      <QuarterDonut year={year} trend={trend} qtd={kpis.qtd} currentQuarter={Math.floor(ref.getUTCMonth() / 3)} />
    </section>
  )
}

/**
 * Quarter donut: two rings, outer = this year, inner = last year, each cut
 * into the four quarters (same hue per quarter on both rings). A quarter's
 * arc length is its share of that year's total, so the seasonal shape is
 * the shape of the ring. Hover a quarter to read it; default is the
 * current quarter, which compares to last year through the same day.
 */
function QuarterDonut({ year, trend, qtd, currentQuarter }: {
  year: number; trend: TrendPoint[]; qtd: KpiBucket; currentQuarter: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const q = segmentsBy(trend, "quarter")
  const sel = hover ?? currentQuarter
  const curTotal = q.reduce((a, g) => a + g.current, 0)
  const priTotal = q.reduce((a, g) => a + g.prior, 0)
  const g = q[sel]
  const isCurrent = sel === currentQuarter
  const prior = isCurrent ? qtd.prior_year ?? 0 : g.prior
  const delta = prior > 0 && g.current > 0 ? ((g.current - prior) / prior) * 100 : null
  const tone = delta == null ? "text-ink-mute" : delta >= 0 ? "text-grass" : "text-coral"

  // Arcs: share of each year's own total, so both rings close at 100%.
  const ring = (values: number[], total: number, r: number, width: number) => {
    let acc = 0
    return values.map((v, i) => {
      const start = acc / (total || 1)
      acc += v
      const end = acc / (total || 1)
      return { i, d: arc(50, 50, r, start, end), width, v }
    })
  }
  const outer = ring(q.map((x) => x.current), priTotal || curTotal, 40, 11)   // outer scaled to LAST year's total so a short year shows a gap
  const inner = ring(q.map((x) => x.prior), priTotal, 27, 11)

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            Quarters <span className="text-ink-mute/60">· {year} vs {year - 1}</span>
          </div>
          <div className="text-[10px] font-mono text-ink-mute truncate">out {year} · in {year - 1}</div>
        </div>

        <div className="flex items-center gap-4 mt-2">
          <svg viewBox="0 0 100 100" className="w-[104px] h-[104px] shrink-0" onMouseLeave={() => setHover(null)}>
            <circle cx="50" cy="50" r="40" fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="11" />
            <circle cx="50" cy="50" r="27" fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="11" />
            {inner.map((a) => a.v > 0 && (
              <path key={`p${a.i}`} d={a.d} fill="none" stroke={seg(q[a.i].hue, sel === a.i)} strokeWidth={a.width}
                opacity={sel === a.i ? 1 : 0.55} onMouseEnter={() => setHover(a.i)}>
                <title>{`Q${a.i + 1} ${year - 1}: ${formatCompactCurrency(a.v)}`}</title>
              </path>
            ))}
            {outer.map((a) => a.v > 0 && (
              <path key={`c${a.i}`} d={a.d} fill="none" stroke={seg(q[a.i].hue, sel === a.i)} strokeWidth={a.width}
                opacity={sel === a.i ? 1 : 0.55} onMouseEnter={() => setHover(a.i)}>
                <title>{`Q${a.i + 1} ${year}: ${formatCompactCurrency(a.v)}`}</title>
              </path>
            ))}
            <text x="50" y="47" textAnchor="middle" className="fill-ink" style={{ fontSize: 13, fontWeight: 600 }}>Q{sel + 1}</text>
            <text x="50" y="59" textAnchor="middle" className="fill-ink-mute" style={{ fontSize: 8 }}>{isCurrent ? "so far" : "full"}</text>
          </svg>

          <div className="min-w-0 font-mono tabular-nums text-[11px] whitespace-nowrap overflow-hidden">
            <div className="font-sans num text-[26px] font-semibold tracking-tight text-ink leading-none">
              {formatCompactCurrency(g.current)}
            </div>
            <div className="mt-1.5 text-ink-mute">Q{sel + 1} {year}{isCurrent ? " so far" : ""}</div>
            <div className="mt-1">
              <span className="text-ink-mute">Q{sel + 1} {year - 1}{isCurrent ? " to date" : ""}</span>{" "}
              <span className="text-ink-dim">{formatCompactCurrency(prior)}</span>
            </div>
            <div className={`mt-1 ${tone}`}>
              {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%${isCurrent ? " pace" : ""}`}
            </div>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-2.5 text-[10px] font-mono text-ink-mute whitespace-nowrap">
          {q.map((x, i) => (
            <button key={x.label} type="button" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              className={`flex items-center gap-1 ${sel === i ? "text-ink" : ""}`}>
              <span className="inline-block w-2 h-2 rounded-[2px]" style={{ background: seg(x.hue, true) }} />{x.label}
            </button>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

/** SVG arc path for a ring segment from `from` to `to` (fractions of a turn, 12 o'clock start). */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const a0 = (from - 0.25) * Math.PI * 2, a1 = (Math.min(to, 0.9999) - 0.25) * Math.PI * 2
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0)
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1)
  const large = to - from > 0.5 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/**
 * The big bar: this year against last year, month by month, one hue per
 * month shared across both rows. Hover a month to read it; leave it to read
 * the year. Everything is the daily ledger's monthly totals; the month in
 * progress compares to last year through the same day.
 */
function YearCompare({ year, trend, ytd }: { year: number; trend: TrendPoint[]; ytd: KpiBucket }) {
  const [hover, setHover] = useState<number | null>(null)
  const current = trend.findIndex((p) => p.partial) >= 0 ? trend.findIndex((p) => p.partial) : Math.max(0, trend.filter((p) => p.current != null).length - 1)
  const segments = segmentsBy(trend, "month")
  const priorTotal = segments.reduce((a, g) => a + g.prior, 0)
  const currentTotal = segments.reduce((a, g) => a + g.current, 0)

  const priorSameDay = ytd.prior_year ?? 0
  const pace = priorSameDay > 0 ? currentTotal / priorSameDay : 1
  const paceDelta = (pace - 1) * 100
  const daysLeft = ytd.workdays_total - ytd.workdays_elapsed

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
  const ytdThrough = (idx: number) => {
    let c = 0, q = 0
    for (let i = 0; i <= idx; i++) {
      c += trend[i].current ?? 0
      q += trend[i].partial ? trend[i].prior_same_days ?? 0 : trend[i].prior ?? 0
    }
    return { c, q }
  }
  const tone = (d: number | null) => d == null ? "text-ink-mute" : d >= 0 ? "text-grass" : "text-coral"
  const pctStr = (d: number | null) => d == null ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`
  const monthLong = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" })

  return (
    <Card className="relative overflow-hidden h-full">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
      <CardBody>
        {/* Header: title left; the year, stated once, right */}
        <div className="flex items-baseline justify-between gap-3 whitespace-nowrap">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            Revenue <span className="text-ink-mute/60">· {year} vs {year - 1}</span>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-ink-mute">{daysLeft} workdays left</div>
        </div>

        {/* Year-to-date gap where the selected month started and where it ended (or
            stands today), on the year scale: the catch-up this month made or lost. */}
        {/* Month tracker: the hovered month, else the month in progress. The two
            short bars are that month's slices lifted out of the year bars below,
            drawn on their own scale so the gap between them is the difference. */}
        {(() => {
          const p = trend[sel]
          const cur = p.current ?? 0
          const pri = p.partial ? p.prior_same_days ?? 0 : p.prior ?? 0
          const mScale = Math.max(cur, pri) || 1
          const d = pri > 0 && p.current != null ? ((cur - pri) / pri) * 100 : null
          const hue = segments[sel].hue
          const label = segments[sel].label
          const diff = p.current != null && pri > 0 ? cur - pri : null
          const yy = (y: number) => `${label} '${String(y).slice(2)}`
          return (
            <div className="mt-2.5 flex items-center gap-6 whitespace-nowrap">
              {/* the number */}
              <div className="shrink-0">
                <div className="font-sans num text-[30px] font-semibold tracking-tight text-ink leading-none">
                  {p.current == null ? "—" : formatCompactCurrency(cur)}
                </div>
                <div className="text-[11px] font-mono mt-1.5 text-ink-dim">
                  {monthLong(p.month)} {year}{p.partial ? " so far" : ""}
                </div>
              </div>

              {/* the two slices as labeled rows: bar · amount · difference, in columns */}
              <table className="text-[11px] font-mono tabular-nums border-separate border-spacing-x-3 border-spacing-y-1 -ml-3">
                <thead className="text-[10px] uppercase tracking-[0.1em] text-ink-mute/70">
                  <tr>
                    <th className="font-normal text-left"></th>
                    <th className="font-normal text-left w-[120px]"></th>
                    <th className="font-normal text-right">revenue</th>
                    <th className="font-normal text-right">$ vs {String(year - 1).slice(2)}</th>
                    <th className="font-normal text-right">% vs {String(year - 1).slice(2)}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-ink-mute">{yy(year)}</td>
                    <td><div className="h-3.5 rounded-sm bg-white/[0.06] overflow-hidden"><div className="h-full" style={{ width: `${(cur / mScale) * 100}%`, background: seg(hue, true) }} /></div></td>
                    <td className="text-right text-ink">{p.current == null ? "—" : formatCompactCurrency(cur)}</td>
                    <td className={`text-right ${tone(d)}`}>{diff == null ? "—" : `${diff >= 0 ? "+" : "-"}${formatCompactCurrency(Math.abs(diff))}`}</td>
                    <td className={`text-right ${tone(d)}`}>{pctStr(d)}</td>
                  </tr>
                  <tr>
                    <td className="text-ink-mute">{yy(year - 1)}</td>
                    <td><div className="h-3.5 rounded-sm bg-white/[0.06] overflow-hidden"><div className="h-full" style={{ width: `${(pri / mScale) * 100}%`, background: seg(hue, false) }} /></div></td>
                    <td className="text-right text-ink-dim">{formatCompactCurrency(pri)}</td>
                    <td></td>
                    <td></td>
                  </tr>
                </tbody>
              </table>

            </div>
          )
        })()}

        <div className="mt-3.5 pt-3 border-t border-line-soft space-y-1.5 text-[11px] font-mono tabular-nums whitespace-nowrap" onMouseLeave={() => setHover(null)}>
          {[
            { row: String(year), values: segments.map((g) => g.current), amount: currentTotal, strong: true },
            { row: String(year - 1), values: segments.map((g) => g.prior), amount: priorTotal, strong: false },
          ].map((r, ri) => (
            <Fragment key={r.row}>
              <div className="flex items-center gap-2">
                <span className="w-10 text-ink-mute">{r.row}</span>
                <div className="flex-1 h-6 rounded-md bg-white/[0.06] overflow-hidden flex gap-px">
                  {segments.map((g, i) => (
                    <Fragment key={g.label}>
                      {r.values[i] > 0 && (
                        <div
                          onMouseEnter={() => setHover(i)}
                          className={`h-full flex items-center justify-center text-[10px] leading-none overflow-hidden cursor-default transition-opacity ${sel === i ? "text-[#0A1622] font-medium" : "text-white/70 opacity-60"}`}
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
                <span className={`w-14 text-right ${r.strong ? "text-ink" : "text-ink-dim"}`} title={ri === 0 ? `booked ${formatCompactCurrency(currentTotal)} + projected` : undefined}>
                  {formatCompactCurrency(ri === 0 ? projectedTotal : r.amount)}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
        {/* The year, stated once */}
        <div className="mt-3 pt-2.5 border-t border-line-soft flex items-baseline justify-between gap-3 text-[11px] font-mono tabular-nums whitespace-nowrap">
          <span className="text-ink-mute"><span className="text-ink">{formatCompactCurrency(currentTotal)}</span> YTD · {((currentTotal / (priorTotal || 1)) * 100).toFixed(0)}% of {year - 1}</span>
          <span className="text-ink-mute"><span className={tone(paceDelta)}>{pctStr(paceDelta)}</span> · <span className={priorTotal - currentTotal > 0 ? "text-ink" : "text-grass"}>{formatCompactCurrency(Math.abs(priorTotal - currentTotal))} {priorTotal - currentTotal > 0 ? "to go" : "over"}</span></span>
        </div>
      </CardBody>
    </Card>
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

