import { createAnon } from "@/lib/supabase/anon"

/**
 * Revenue dashboard data layer.
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
  const rows = await fetchViewRows({
    fromMonth: opts.startMonth,
    toMonthExclusive: opts.endMonth,
  })

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

// ── Trend (with YoY overlay) ─────────────────────────────────────────────

export interface TrendPoint {
  month: string                         // 'YYYY-MM-01'
  current_revenue: number
  prior_year_revenue: number | null     // null when no data for that prior month
}

export async function getRevenueTrend(opts: {
  startMonth: string
  endMonth: string
}): Promise<TrendPoint[]> {
  // Fetch a year back for YoY overlay.
  const priorStart = shiftYearBack(opts.startMonth)
  const rows = await fetchViewRows({
    fromMonth: priorStart,
    toMonthExclusive: opts.endMonth,
  })

  const monthTotals = new Map<string, number>()
  for (const r of rows) {
    monthTotals.set(r.month, (monthTotals.get(r.month) ?? 0) + Number(r.sub_total ?? 0))
  }

  return generateMonths(opts.startMonth, opts.endMonth).map((m) => ({
    month: m,
    current_revenue: monthTotals.get(m) ?? 0,
    prior_year_revenue: monthTotals.has(shiftYearBack(m))
      ? monthTotals.get(shiftYearBack(m))!
      : null,
  }))
}

// ── KPIs (MTD / QTD / YTD + YoY) ─────────────────────────────────────────

export interface KpiBucket {
  revenue: number
  prior_year: number | null
  yoy_pct: number | null
}

export interface RevenueKpis {
  mtd: KpiBucket
  qtd: KpiBucket
  ytd: KpiBucket
  reference_date: string
}

export async function getRevenueKpis(
  referenceDate: Date = new Date(),
): Promise<RevenueKpis> {
  const ref = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ))

  // Fetch everything from 2 years back (covers YoY for YTD).
  const fromMonth = `${ref.getUTCFullYear() - 1}-01-01`
  const toExclusive = isoDate(addDays(ref, 1))
  const rows = await fetchViewRowsByCompleted({
    fromCompleted: fromMonth,
    toCompletedExclusive: toExclusive,
  })

  const [mtdStart, mtdEnd] = periodRange(ref, "month")
  const [qtdStart, qtdEnd] = periodRange(ref, "quarter")
  const [ytdStart, ytdEnd] = periodRange(ref, "year")

  function sumRange(startIso: string, endIsoExclusive: string): number {
    let total = 0
    for (const r of rows) {
      if (r.completed >= startIso && r.completed < endIsoExclusive) {
        total += Number(r.sub_total ?? 0)
      }
    }
    return total
  }

  function bucket(startIso: string, endIsoExclusive: string): KpiBucket {
    const cur = sumRange(startIso, endIsoExclusive)
    const prior = sumRange(shiftYearBack(startIso), shiftYearBack(endIsoExclusive))
    return {
      revenue: cur,
      prior_year: prior > 0 ? prior : null,
      yoy_pct: prior > 0 ? ((cur - prior) / prior) * 100 : null,
    }
  }

  return {
    mtd: bucket(mtdStart, mtdEnd),
    qtd: bucket(qtdStart, qtdEnd),
    ytd: bucket(ytdStart, ytdEnd),
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
      .gte("month", opts.fromMonth)
      .lt("month", opts.toMonthExclusive)
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`v_revenue_by_month: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...(data as ViewRow[]))
    if (data.length < PAGE) break
    offset += PAGE
  }
  return all
}

async function fetchViewRowsByCompleted(opts: {
  fromCompleted: string
  toCompletedExclusive: string
}): Promise<ViewRow[]> {
  const sb = createAnon("public")
  const all: ViewRow[] = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from("v_revenue_by_month")
      .select("sub_total, completed, month")
      .gte("completed", opts.fromCompleted)
      .lt("completed", opts.toCompletedExclusive)
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
    const start = new Date(Date.UTC(y, m, 1))
    const end = addDays(ref, 1)
    return [isoDate(start), isoDate(end)]
  }
  if (bucket === "quarter") {
    const qMonth = Math.floor(m / 3) * 3
    const start = new Date(Date.UTC(y, qMonth, 1))
    const end = addDays(ref, 1)
    return [isoDate(start), isoDate(end)]
  }
  const start = new Date(Date.UTC(y, 0, 1))
  const end = addDays(ref, 1)
  return [isoDate(start), isoDate(end)]
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

// ─── Presets used by both the server initial render + the API route ─────

export function defaultDateRange(
  referenceDate: Date = new Date(),
): { startMonth: string; endMonth: string } {
  const ref = new Date(referenceDate)
  // Last 6 months, inclusive of the current month. endMonth is exclusive so
  // it points to the first of next month.
  const endMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1))
  const startMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 5, 1))
  return {
    startMonth: isoDate(startMonth),
    endMonth: isoDate(endMonth),
  }
}
