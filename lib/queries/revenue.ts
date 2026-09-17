import { createAnon } from "@/lib/supabase/anon"
import { workdays } from "@/lib/utils/workdays"

/**
 * Revenue dashboard data layer. SERVICE revenue only: every fetch filters
 * `revenue_class = 'Service'` (QBO invoice class, or the pipeline's
 * mechanical rule for history rows without an invoice).
 *
 * Backed by `public.v_revenue_by_month` — one row per (month × work_order),
 * with location / tech / department resolved via employees + departments.
 * All aggregation + pivoting happens here in JS because the shapes differ
 * per view (trend line vs pivot table vs drilldown), and the volume is
 * small (~1500 billable WOs per year).
 *
 * If volume grows past ~10k rows per fetch, move the pivot to a Postgres
 * RPC and call via `.rpc(...)`.
 */

// PostgREST default max_rows is 1000 and asking for more doesn't override
// the server cap — we just get 1000 and the loop silently exits. Set the
// page size to the server cap so the "did we get a full page?" termination
// check actually works.
const PAGE = 1000

export type Dimension = "location" | "tech" | "department"
export type Measure = "revenue" | "count"

interface ViewRow {
  wo_number: string
  month: string        // 'YYYY-MM-DD' (first of month)
  completed: string    // 'YYYY-MM-DD'
  location: string | null
  tech: string
  department: string
  customer: string | null
  wo_type: string | null
  sub_total: number
  total_due: number
  qbo_invoice_id: string | null
  employee_id: string | null
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface PivotRow {
  key: string
  byMonth: Record<string, number>
  total: number
}

export interface PivotResult {
  months: string[]                      // ['2025-11-01', ..., '2026-04-01']
  rows: PivotRow[]                      // sorted by total desc
  monthTotals: Record<string, number>
  grandTotal: number
}

/**
 * Label the "non-Service techs aggregated" bucket uses when dimension = tech.
 * Used both as the row key in PivotResult and as a sentinel that the
 * drilldown UI recognizes (and handles specially by omitting the tech
 * filter, since the bucket is a union).
 */
export const TECH_OTHER_BUCKET = "Other departments"

export async function getRevenueBreakdown(opts: {
  dimension: Dimension
  measure: Measure
  startMonth: string   // 'YYYY-MM-01'
  endMonth: string     // 'YYYY-MM-01' exclusive
}): Promise<PivotResult> {
  const rows = await fetchViewRows({ fromMonth: opts.startMonth, toMonthExclusive: opts.endMonth })

  const months = generateMonths(opts.startMonth, opts.endMonth)
  const rowMap = new Map<string, Record<string, number>>()
  const monthTotals: Record<string, number> = {}
  let grandTotal = 0

  for (const r of rows) {
    let dimKey = dimensionValue(r, opts.dimension)
    if (!dimKey) continue

    // Tech view: only show techs whose employee record is in the Service
    // department. Everything else (Maintenance, Retail, Slide Crew, Back
    // Office, Unassigned) rolls into a single "Other departments" row so
    // the table isn't dominated by non-service-sales employees.
    if (opts.dimension === "tech" && r.department !== "Service") {
      dimKey = TECH_OTHER_BUCKET
    }

    const monthKey = r.month
    const val = opts.measure === "revenue" ? Number(r.sub_total ?? 0) : 1

    if (!rowMap.has(dimKey)) rowMap.set(dimKey, {})
    const row = rowMap.get(dimKey)!
    row[monthKey] = (row[monthKey] ?? 0) + val
    monthTotals[monthKey] = (monthTotals[monthKey] ?? 0) + val
    grandTotal += val
  }

  const pivotRows: PivotRow[] = Array.from(rowMap.entries())
    .map(([key, byMonth]) => ({
      key,
      byMonth,
      total: Object.values(byMonth).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => {
      // Keep the "Other departments" bucket at the bottom regardless of
      // total — it's a catch-all, not a leaderboard entry.
      if (a.key === TECH_OTHER_BUCKET) return 1
      if (b.key === TECH_OTHER_BUCKET) return -1
      return b.total - a.total
    })

  return { months, rows: pivotRows, monthTotals, grandTotal }
}

// ── Daily ledger: the one surface the tiles, trend, hover, and table use ─

export interface DailyRow {
  day: string                           // 'YYYY-MM-DD'
  year: number
  revenue: number                       // Service-class revenue completed that day
  cumulative: number                    // running total within the year
}

/** Every day of `year`, the year before, and the December before that (the trend's Jan 1 lead-in). */
export async function getServiceDaily(year: number): Promise<DailyRow[]> {
  const sb = createAnon("public")
  const out: DailyRow[] = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from("v_service_revenue_daily")
      .select("day, year, revenue, cumulative")
      .gte("day", `${year - 2}-12-01`)
      .lt("day", `${year + 1}-01-01`)
      .order("day")
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`v_service_revenue_daily: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as Array<Record<string, unknown>>) {
      out.push({ day: String(r.day), year: Number(r.year), revenue: Number(r.revenue ?? 0), cumulative: Number(r.cumulative ?? 0) })
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return out
}

/** { 'YYYY-MM-DD': revenue } for the hover's exact to-date sums. */
export function dailyMap(rows: DailyRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.day] = r.revenue
  return out
}

// ── Trend: monthly revenue, this year vs last ───────────────────────────

export interface TrendPoint {
  month: string                         // 'YYYY-MM-01' in the current year
  current: number | null                // this year's total for the month; null after the current month
  prior: number | null                  // last year's total for the same month
  partial: boolean                      // the month in progress: `current` is booked so far, not a full month
  prior_same_days: number | null        // partial month only: last year's same month through the same day
}

/**
 * Twelve points, Jan..Dec of `year`, each with this year's and last year's
 * monthly total, summed from the daily ledger. The month in progress
 * carries what has been booked so far (never a projection) and, for a
 * like-for-like hover, last year's same month through the same day.
 */
export function revenueTrend(rows: DailyRow[], year: number, today: Date = new Date()): TrendPoint[] {
  const totals = new Map<string, number>()
  for (const r of rows) {
    const m = r.day.slice(0, 7)
    totals.set(m, (totals.get(m) ?? 0) + r.revenue)
  }
  const todayIso = isoDate(today)
  const thisMonth = todayIso.slice(0, 7)
  return generateMonths(`${year}-01-01`, `${year + 1}-01-01`).map((m) => {
    const ym = m.slice(0, 7)
    const prior = totals.get(shiftYearBack(m).slice(0, 7)) ?? 0
    if (ym > thisMonth) return { month: m, current: null, prior, partial: false, prior_same_days: null }
    const actual = totals.get(ym) ?? 0
    if (ym < thisMonth) return { month: m, current: actual, prior, partial: false, prior_same_days: null }
    const priorStart = shiftYearBack(m)
    const priorCutoff = shiftYearBack(isoDate(addDays(today, 1)))
    let priorSameDays = 0
    for (const r of rows) if (r.day >= priorStart && r.day < priorCutoff) priorSameDays += r.revenue
    return { month: m, current: actual, prior, partial: true, prior_same_days: priorSameDays }
  })
}

// ── KPIs (MTD / QTD / YTD, YoY by workday pace) ──────────────────────────

export interface KpiBucket {
  revenue: number                       // this period through today
  workdays_elapsed: number              // workdays in the period through today
  workdays_total: number                // workdays in the whole period
  per_workday: number
  prior_full: number                    // last year's WHOLE period: the tile's goal line
  prior_year: number | null             // last year's period through the same day
  prior_workdays: number
  prior_per_workday: number | null
  yoy_pct: number | null                // per-workday pace vs the same period last year
}

export interface RevenueKpis {
  mtd: KpiBucket
  qtd: KpiBucket
  ytd: KpiBucket
  reference_date: string
}

/**
 * Each tile compares this period's revenue per workday (through today)
 * with last year's revenue per workday over the SAME period through the
 * same day. Ruled 2026-09-16: the baseline is where we were a year ago,
 * not last year's full-period average. Per workday (Mon..Fri less
 * holidays) rather than raw totals so a weekend or holiday shift does not
 * read as a swing. Sums come straight from the daily ledger.
 */
export function revenueKpis(rows: DailyRow[], referenceDate: Date = new Date()): RevenueKpis {
  const ref = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ))
  const byDay = dailyMap(rows)

  function sumRange(startIso: string, endIsoExclusive: string): number {
    let total = 0
    for (const [day, v] of Object.entries(byDay)) {
      if (day >= startIso && day < endIsoExclusive) total += v
    }
    return total
  }

  function bucket(kind: "month" | "quarter" | "year"): KpiBucket {
    const [start, fullEnd] = periodRange(ref, kind)
    const throughToday = isoDate(addDays(ref, 1))
    const revenue = sumRange(start, throughToday)
    const workdaysElapsed = workdays(start, throughToday)
    const workdaysTotal = workdays(start, fullEnd)
    const priorStart = shiftYearBack(start)
    const priorEnd = shiftYearBack(throughToday)
    const prior = sumRange(priorStart, priorEnd)
    const priorFull = sumRange(priorStart, shiftYearBack(fullEnd))
    const priorWorkdays = workdays(priorStart, priorEnd)
    const perWorkday = workdaysElapsed > 0 ? revenue / workdaysElapsed : 0
    const priorPerWorkday = prior > 0 && priorWorkdays > 0 ? prior / priorWorkdays : null
    return {
      revenue,
      workdays_elapsed: workdaysElapsed,
      workdays_total: workdaysTotal,
      per_workday: perWorkday,
      prior_full: priorFull,
      prior_year: prior > 0 ? prior : null,
      prior_workdays: priorWorkdays,
      prior_per_workday: priorPerWorkday,
      yoy_pct: priorPerWorkday ? ((perWorkday - priorPerWorkday) / priorPerWorkday) * 100 : null,
    }
  }

  return {
    mtd: bucket("month"),
    qtd: bucket("quarter"),
    ytd: bucket("year"),
    reference_date: isoDate(ref),
  }
}

// NOTE: the previous slide-over drilldown (getRevenueDrilldown + its API
// route) was removed. Drilldown now navigates to /work-orders with filter
// query params — the WO sub-module is the authoritative browsing surface.

// ─── Internals ───────────────────────────────────────────────────────────

async function fetchViewRows(opts: {
  fromMonth: string
  toMonthExclusive: string
}): Promise<ViewRow[]> {
  const sb = createAnon("public")
  const all: ViewRow[] = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from("v_revenue_by_month")
      .select(
        "wo_number, month, completed, location, tech, department, customer, wo_type, sub_total, total_due, qbo_invoice_id, employee_id",
      )
      .eq("revenue_class", "Service")
      .gte("month", opts.fromMonth)
      .lt("month", opts.toMonthExclusive)
      // Paging without an ORDER BY is undefined in PostgREST: pages can
      // overlap or skip once the view is large (it did after the 2019-2025
      // history backfill: MTD/QTD read $0). wo_number is the view's key.
      .order("wo_number")
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`v_revenue_by_month: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...(data as ViewRow[]))
    if (data.length < PAGE) break
    offset += PAGE
  }
  return all
}

function dimensionValue(row: ViewRow, dim: Dimension): string | null {
  if (dim === "location") return row.location ?? null
  if (dim === "tech") return row.tech
  if (dim === "department") return row.department
  return null
}

function generateMonths(startIso: string, endIsoExclusive: string): string[] {
  const out: string[] = []
  const cursor = new Date(startIso + "T00:00:00Z")
  const end = new Date(endIsoExclusive + "T00:00:00Z")
  while (cursor < end) {
    out.push(isoDate(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out
}

function periodRange(ref: Date, bucket: "month" | "quarter" | "year"): [string, string] {
  const y = ref.getUTCFullYear()
  const m = ref.getUTCMonth()
  if (bucket === "month") {
    return [isoDate(new Date(Date.UTC(y, m, 1))), isoDate(new Date(Date.UTC(y, m + 1, 1)))]
  }
  if (bucket === "quarter") {
    const qMonth = Math.floor(m / 3) * 3
    return [isoDate(new Date(Date.UTC(y, qMonth, 1))), isoDate(new Date(Date.UTC(y, qMonth + 3, 1)))]
  }
  return [`${y}-01-01`, `${y + 1}-01-01`]
}

function addDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n))
}

function shiftYearBack(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  return isoDate(d)
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
