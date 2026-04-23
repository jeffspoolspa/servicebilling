import { createAnon } from "@/lib/supabase/anon"
import { CTA_TECHS } from "@/lib/queries/bonuses"

/**
 * Work Orders browser query layer.
 *
 * Backed by `public.v_revenue_by_month` (same view the dashboard uses) so
 * this page's numbers tie out exactly to the pivot. The view is
 * invoice-driven — it INNER JOINs billing.invoices and buckets by
 * invoice.txn_date — so /work-orders only ever shows invoiced WOs.
 * Uninvoiced WOs live under /service-billing/awaiting-invoice.
 */

export interface WorkOrderFilters {
  month?: string          // 'YYYY-MM' — bucketed by invoice.txn_date month
  office?: string         // location dimension
  tech?: string           // tech dimension (single person)
  department?: string     // employees.department name
  /**
   * Special bucket used by the dashboard drilldown when the user clicks
   * the "Other departments" row in the tech pivot — signals "include
   * everyone NOT in Service dept" since that row is a union, not a
   * single tech. Mutually exclusive with `department` and `tech`.
   */
  techOther?: boolean
  type?: string           // wo.type
  q?: string              // free-text search on WO/customer/invoice#
  /**
   * Bonus-pool filter. `true` or `false` narrow to those rows; `undefined`
   * returns all. Driven by the Monthly Bonuses card drilldown.
   */
  bonus?: boolean
  /**
   * Semantic filter: "the three Brunswick service techs" (Chance / Travis
   * / Aaron Bass). Used for Zach's bonus drilldown since his bonus is
   * indexed to their combined revenue. Mutually exclusive with `tech`.
   */
  ctaGroup?: boolean
}

export interface WorkOrderRow {
  wo_number: string
  customer: string | null
  wo_type: string | null
  tech: string
  location: string | null
  department: string
  completed: string       // this is the INVOICE txn_date (view column retained for API compat)
  sub_total: number
  total_due: number
  qbo_invoice_id: string | null
  invoice_doc_number: string | null
  invoice_balance: number | null
  invoice_qbo_class: string | null
  billing_status: string | null
  /** Effective bonus-inclusion value (override if set, else computed from qbo_class). */
  included_in_bonus: boolean
  /** The raw override value. null means "follow the computed default". */
  bonus_override: boolean | null
}

export interface WorkOrderListResult {
  rows: WorkOrderRow[]
  total: number
}

export async function getWorkOrders(opts: {
  filters: WorkOrderFilters
  sortBy?: string
  sortDir?: "asc" | "desc"
  offset?: number
  limit?: number
}): Promise<WorkOrderListResult> {
  const sb = createAnon("public")
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? 50
  const sortBy = opts.sortBy ?? "completed"
  const sortDir = opts.sortDir ?? "desc"

  let q = sb
    .from("v_revenue_by_month")
    .select(
      "wo_number, customer, wo_type, tech, location, department, completed, sub_total, total_due, qbo_invoice_id, invoice_doc_number, invoice_balance, invoice_qbo_class, billing_status, included_in_bonus, bonus_override",
      { count: "exact" },
    )
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(offset, offset + limit - 1)

  q = applyFilters(q, opts.filters)

  const { data, count, error } = await q
  if (error) {
    console.error("getWorkOrders error:", error)
    return { rows: [], total: 0 }
  }

  return {
    rows: (data ?? []).map((r: Record<string, unknown>) => ({
      wo_number: String(r.wo_number ?? ""),
      customer: (r.customer ?? null) as string | null,
      wo_type: (r.wo_type ?? null) as string | null,
      tech: (r.tech ?? "Unassigned") as string,
      location: (r.location ?? null) as string | null,
      department: (r.department ?? "Unassigned") as string,
      completed: String(r.completed ?? ""),
      sub_total: Number(r.sub_total ?? 0),
      total_due: Number(r.total_due ?? 0),
      qbo_invoice_id: (r.qbo_invoice_id ?? null) as string | null,
      invoice_doc_number: (r.invoice_doc_number ?? null) as string | null,
      invoice_balance:
        r.invoice_balance == null ? null : Number(r.invoice_balance),
      invoice_qbo_class: (r.invoice_qbo_class ?? null) as string | null,
      billing_status: (r.billing_status ?? null) as string | null,
      included_in_bonus: Boolean(r.included_in_bonus),
      bonus_override:
        r.bonus_override === null || r.bonus_override === undefined
          ? null
          : Boolean(r.bonus_override),
    })),
    total: count ?? 0,
  }
}

/** Totals for the currently-filtered set — rendered above the table so
 *  the user sees the aggregate of their filter, not just one page. */
export interface WorkOrderTotals {
  count: number
  sub_total: number
}

export async function getWorkOrderTotals(
  filters: WorkOrderFilters,
): Promise<WorkOrderTotals> {
  // Separate query so we don't cap totals at the paged `limit`. We only
  // need sub_total per row to sum — select a narrow slice to stay cheap.
  const sb = createAnon("public")
  // PostgREST server-side cap is 1000 rows; requesting more silently
  // truncates. Must match the cap so the "did we get a full page?"
  // termination check actually pages correctly.
  const PAGE = 1000
  let offset = 0
  let total = 0
  let count = 0
  while (true) {
    let q = sb
      .from("v_revenue_by_month")
      .select("sub_total", { count: "exact" })
      .range(offset, offset + PAGE - 1)
    q = applyFilters(q, filters)
    const { data, error, count: c } = await q
    if (error) {
      console.error("getWorkOrderTotals error:", error)
      return { count: 0, sub_total: 0 }
    }
    if (!data || data.length === 0) {
      if (c != null) count = c
      break
    }
    for (const r of data as Array<{ sub_total: number | string | null }>) {
      total += Number(r.sub_total ?? 0)
    }
    if (c != null) count = c
    if (data.length < PAGE) break
    offset += PAGE
  }
  return { count, sub_total: total }
}

/** Distinct value lists used to populate the filter dropdowns. Cached at
 *  the page level — invoke once per page render. */
export interface FilterOptions {
  offices: string[]
  techs: Array<{ name: string; department: string }>
  departments: string[]
  types: string[]
  months: string[]          // 'YYYY-MM' strings, descending (most recent first)
}

export async function getWorkOrderFilterOptions(): Promise<FilterOptions> {
  const sb = createAnon("public")
  // Page through the view to build option lists. PostgREST caps responses
  // at 1000 rows by default; loop until we see a short page.
  const PAGE = 1000
  let offset = 0
  const offices = new Set<string>()
  const techs = new Map<string, string>()
  const departments = new Set<string>()
  const types = new Set<string>()
  const months = new Set<string>()

  while (true) {
    const { data } = await sb
      .from("v_revenue_by_month")
      .select("location, tech, department, wo_type, month")
      .range(offset, offset + PAGE - 1)
    if (!data || data.length === 0) break
    for (const r of data as Array<Record<string, unknown>>) {
      if (r.location) offices.add(String(r.location))
      if (r.tech) techs.set(String(r.tech), String(r.department ?? "Unassigned"))
      if (r.department) departments.add(String(r.department))
      if (r.wo_type) types.add(String(r.wo_type))
      if (r.month) months.add(String(r.month).slice(0, 7))
    }
    if (data.length < PAGE) break
    offset += PAGE
  }

  return {
    offices: Array.from(offices).sort(),
    techs: Array.from(techs.entries())
      .map(([name, department]) => ({ name, department }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    departments: Array.from(departments).sort(),
    types: Array.from(types).sort(),
    months: Array.from(months).sort().reverse(),
  }
}

// ─── Internals ──────────────────────────────────────────────────────────

type PostgrestQuery = ReturnType<
  ReturnType<typeof createAnon>["from"]
>["select"] extends (...args: unknown[]) => infer R ? R : never

function applyFilters<Q extends {
  gte: (col: string, v: string) => Q
  lt: (col: string, v: string) => Q
  eq: (col: string, v: string | boolean) => Q
  neq: (col: string, v: string) => Q
  in: (col: string, values: readonly string[]) => Q
  or: (filter: string) => Q
}>(q: Q, f: WorkOrderFilters): Q {
  if (f.month && /^\d{4}-\d{2}$/.test(f.month)) {
    const start = `${f.month}-01`
    const end = nextMonthIso(start)
    q = q.gte("month", start).lt("month", end)
  }
  if (f.office) q = q.eq("location", f.office)
  if (f.tech) {
    q = q.eq("tech", f.tech)
  } else if (f.ctaGroup) {
    // Semantic bucket: the three Brunswick service techs whose combined
    // revenue drives Zach's bonus. Drilling into Zach lands here.
    q = q.in("tech", CTA_TECHS)
  }
  if (f.department) q = q.eq("department", f.department)
  if (f.techOther && !f.tech && !f.department && !f.ctaGroup) {
    // Synthetic "Other departments" bucket from the tech pivot. Include
    // everyone NOT in Service dept.
    q = q.neq("department", "Service")
  }
  if (f.type) q = q.eq("wo_type", f.type)
  if (f.bonus !== undefined) {
    q = q.eq("included_in_bonus", f.bonus)
  }
  if (f.q) {
    const safe = f.q.replace(/[,()]/g, " ").trim()
    if (safe) {
      q = q.or(
        `wo_number.ilike.%${safe}%,customer.ilike.%${safe}%,invoice_doc_number.ilike.%${safe}%`,
      )
    }
  }
  return q
}

function nextMonthIso(firstOfMonth: string): string {
  const d = new Date(firstOfMonth + "T00:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

// Avoid unused-type warning from the helper; referenced for clarity.
export type _InternalPostgrestQuery = PostgrestQuery
