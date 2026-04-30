import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Module-private query helpers backed by the maintenance.v_* views.
 *
 * The views denormalize customer/service-location/employee display info onto
 * each row so pages can render flat tables without doing client-side joins
 * or fragile multi-FK PostgREST embeds.
 *
 * Phase 2 split: tasks are customer-level (one per service_location);
 * task_schedules are slot-level (one per (task, day)). Routes view
 * aggregates schedules. v_active_techs counts active schedules.
 */

export type BillingMethod = "per_visit" | "flat_rate_monthly"

export interface VisitContextRow {
  id: string
  service_location_id: number
  task_id: string | null
  task_schedule_id: string | null
  scheduled_date: string
  visit_date: string
  scheduled_tech_id: string | null
  actual_tech_id: string | null
  scheduled_start: string | null
  started_at: string | null
  ended_at: string | null
  status: "scheduled" | "in_progress" | "completed" | "skipped" | "canceled"
  visit_type: "route" | "qc" | "makeup" | "service_call" | "repair" | "seasonal"
  price_cents: number | null
  billing_method: BillingMethod
  flat_rate_monthly_cents: number | null
  snapshot_frequency: string | null
  work_order_wo_number: string | null
  ion_work_order_id: string | null
  office: string | null
  notes: string | null
  service_location_street: string | null
  service_location_city: string | null
  customer_id: number | null
  customer_name: string | null
  scheduled_tech_name: string | null
  actual_tech_name: string | null
}

export interface TaskContextRow {
  id: string
  service_location_id: number
  chem_budget_cents: number | null
  status: "active" | "paused" | "closed"
  pause_reason: string | null
  starts_on: string
  ends_on: string | null
  notes: string | null
  service_location_street: string | null
  service_location_city: string | null
  customer_id: number | null
  customer_name: string | null
}

/** A schedule slot — one (tech, day, frequency, price) for a task. */
export interface TaskScheduleContextRow {
  id: string
  task_id: string
  task_status: "active" | "paused" | "closed"
  service_location_id: number
  tech_employee_id: string | null
  day_of_week: number | null
  frequency: string | null
  price_per_visit_cents: number | null
  billing_method: BillingMethod
  flat_rate_monthly_cents: number | null
  sequence: number | null
  office: string | null
  ion_task_id: string | null
  active: boolean
  service_location_street: string | null
  service_location_city: string | null
  customer_id: number | null
  customer_name: string | null
  tech_name: string | null
  chem_budget_cents: number | null
}

export interface RouteSummaryRow {
  office: string | null
  tech_employee_id: string
  tech_name: string | null
  day_of_week: number
  stop_count: number
  total_price_cents: number | null
  flat_rate_per_visit_cents: number | null
  per_visit_cents: number | null
  weekly_count: number
  biweekly_count: number
  monthly_count: number
}

export interface ActiveTechRow {
  employee_id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  department: string | null
  active_task_count: number
  days_serviced: number
  total_per_visit_cents: number | null
}

export async function listUpcomingVisits(opts?: {
  limit?: number
  fromDate?: string
  toDate?: string
}): Promise<VisitContextRow[]> {
  const supabase = await createSupabaseServer()
  const today = new Date().toISOString().slice(0, 10)
  let query = supabase
    .schema("maintenance")
    .from("v_visits_with_context")
    .select("*")
    .gte("visit_date", opts?.fromDate ?? today)
    .order("visit_date", { ascending: true })
    .order("scheduled_start", { ascending: true, nullsFirst: false })
    .limit(opts?.limit ?? 200)
  if (opts?.toDate) query = query.lte("visit_date", opts.toDate)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as unknown as VisitContextRow[]
}

export async function getVisitWithContext(id: string): Promise<VisitContextRow | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("v_visits_with_context")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  return (data as unknown as VisitContextRow) ?? null
}

export async function listRouteSummary(): Promise<RouteSummaryRow[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_routes_summary")
    .select("*")
    .order("day_of_week", { ascending: true })
    .order("tech_name", { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as RouteSummaryRow[]
}

export async function listRouteStops(
  techEmployeeId: string,
  dayOfWeek: number,
): Promise<TaskScheduleContextRow[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_task_schedules_with_context")
    .select("*")
    .eq("active", true)
    .eq("task_status", "active")
    .eq("tech_employee_id", techEmployeeId)
    .eq("day_of_week", dayOfWeek)
    .order("sequence", { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as unknown as TaskScheduleContextRow[]
}

export async function listActiveTechs(): Promise<ActiveTechRow[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_active_techs")
    .select("*")
  if (error) throw error
  return (data ?? []) as unknown as ActiveTechRow[]
}

export interface DashboardKpis {
  active_tasks: number
  visits_today: number
  visits_this_week: number
  visits_completed_this_week: number
  visits_skipped_this_week: number
  total_pools: number
  active_techs: number
}

export async function getMaintenanceDashboardKpis(): Promise<DashboardKpis> {
  const supabase = await createSupabaseServer()

  const today = new Date().toISOString().slice(0, 10)
  const sunday = new Date()
  sunday.setDate(sunday.getDate() - sunday.getDay())
  const weekStart = sunday.toISOString().slice(0, 10)
  const weekEnd = new Date(sunday)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const weekEndStr = weekEnd.toISOString().slice(0, 10)

  const [tasks, todayCount, weekCount, completedCount, skippedCount, pools, techs] =
    await Promise.all([
      supabase.schema("maintenance").from("tasks").select("*", { count: "exact", head: true }).eq("status", "active"),
      supabase.schema("maintenance").from("visits").select("*", { count: "exact", head: true }).eq("visit_date", today),
      supabase.schema("maintenance").from("visits").select("*", { count: "exact", head: true }).gte("visit_date", weekStart).lt("visit_date", weekEndStr),
      supabase.schema("maintenance").from("visits").select("*", { count: "exact", head: true }).gte("visit_date", weekStart).lt("visit_date", weekEndStr).eq("status", "completed"),
      supabase.schema("maintenance").from("visits").select("*", { count: "exact", head: true }).gte("visit_date", weekStart).lt("visit_date", weekEndStr).eq("status", "skipped"),
      supabase.from("pools").select("*", { count: "exact", head: true }),
      supabase.schema("maintenance").from("v_active_techs").select("*", { count: "exact", head: true }),
    ])

  return {
    active_tasks: tasks.count ?? 0,
    visits_today: todayCount.count ?? 0,
    visits_this_week: weekCount.count ?? 0,
    visits_completed_this_week: completedCount.count ?? 0,
    visits_skipped_this_week: skippedCount.count ?? 0,
    total_pools: pools.count ?? 0,
    active_techs: techs.count ?? 0,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Customer-detail queries — for /maintenance/customers and detail page.
// "Active maintenance customer" = a customer with at least one active task
// at any of their service_locations.
// ──────────────────────────────────────────────────────────────────────────────

export interface MaintenanceCustomerListRow {
  customer_id: number
  display_name: string | null
  active_task_count: number
  active_schedule_count: number
  total_per_visit_cents: number
  total_flat_rate_monthly_cents: number
  primary_office: string | null
  service_location_count: number
}

export async function listMaintenanceCustomers(): Promise<MaintenanceCustomerListRow[]> {
  const supabase = await createSupabaseServer()
  // Pull active task→schedule rows with denormalized customer info, then
  // aggregate in JS (PostgREST has no good GROUP BY).
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_task_schedules_with_context")
    .select(
      "customer_id, customer_name, service_location_id, office, price_per_visit_cents, billing_method, flat_rate_monthly_cents, task_id",
    )
    .eq("active", true)
    .eq("task_status", "active")
  if (error) throw error
  const rows = (data ?? []) as Array<{
    customer_id: number | null
    customer_name: string | null
    service_location_id: number
    office: string | null
    price_per_visit_cents: number | null
    billing_method: BillingMethod
    flat_rate_monthly_cents: number | null
    task_id: string
  }>

  type Agg = {
    customer_id: number
    display_name: string | null
    tasks: Set<string>
    locations: Set<number>
    offices: Map<string, number>
    schedule_count: number
    total_per_visit_cents: number
    total_flat_rate_monthly_cents: number
    flat_tasks_seen: Set<string>
  }
  const byCustomer = new Map<number, Agg>()
  for (const r of rows) {
    if (r.customer_id == null) continue
    let agg = byCustomer.get(r.customer_id)
    if (!agg) {
      agg = {
        customer_id: r.customer_id,
        display_name: r.customer_name,
        tasks: new Set(),
        locations: new Set(),
        offices: new Map(),
        schedule_count: 0,
        total_per_visit_cents: 0,
        total_flat_rate_monthly_cents: 0,
        flat_tasks_seen: new Set(),
      }
      byCustomer.set(r.customer_id, agg)
    }
    agg.tasks.add(r.task_id)
    agg.locations.add(r.service_location_id)
    if (r.office) agg.offices.set(r.office, (agg.offices.get(r.office) ?? 0) + 1)
    agg.schedule_count++
    agg.total_per_visit_cents += r.price_per_visit_cents ?? 0
    if (r.billing_method === "flat_rate_monthly" && !agg.flat_tasks_seen.has(r.task_id)) {
      agg.total_flat_rate_monthly_cents += r.flat_rate_monthly_cents ?? 0
      agg.flat_tasks_seen.add(r.task_id)
    }
  }
  const out: MaintenanceCustomerListRow[] = []
  for (const a of byCustomer.values()) {
    let primaryOffice: string | null = null
    let bestN = 0
    for (const [o, n] of a.offices) if (n > bestN) { bestN = n; primaryOffice = o }
    out.push({
      customer_id: a.customer_id,
      display_name: a.display_name,
      active_task_count: a.tasks.size,
      active_schedule_count: a.schedule_count,
      total_per_visit_cents: a.total_per_visit_cents,
      total_flat_rate_monthly_cents: a.total_flat_rate_monthly_cents,
      primary_office: primaryOffice,
      service_location_count: a.locations.size,
    })
  }
  out.sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? ""))
  return out
}

export interface MaintenanceCustomerDetail {
  customer: {
    id: number
    display_name: string | null
    qbo_customer_id: string | null
    is_active: boolean
    email: string | null
    phone: string | null
    customer_type: string | null
  }
  service_locations: Array<{
    id: number
    street: string | null
    city: string | null
    state: string | null
    zip: string | null
    is_primary: boolean
  }>
  tasks: TaskContextRow[]
  schedules: TaskScheduleContextRow[]
  visits: VisitContextRow[]
  audit: Array<{
    kind: "task" | "schedule"
    id: number
    target_id: string
    changed_at: string
    operation: string
    diff: Record<string, unknown> | null
  }>
}

export async function getMaintenanceCustomerDetail(
  customerId: number,
): Promise<MaintenanceCustomerDetail | null> {
  const supabase = await createSupabaseServer()
  const { data: cust } = await supabase
    .from("Customers")
    .select("id, display_name, qbo_customer_id, is_active, email, phone, customer_type")
    .eq("id", customerId)
    .maybeSingle()
  if (!cust) return null

  const { data: locs } = await supabase
    .from("service_locations")
    .select("id, street, city, state, zip, is_primary")
    .eq("account_id", customerId)
    .order("is_primary", { ascending: false })
    .order("id", { ascending: true })
  const locations = (locs ?? []) as MaintenanceCustomerDetail["service_locations"]
  const locIds = locations.map((l) => l.id)
  if (locIds.length === 0) {
    return {
      customer: cust as MaintenanceCustomerDetail["customer"],
      service_locations: [],
      tasks: [],
      schedules: [],
      visits: [],
      audit: [],
    }
  }

  const [tasksRes, schedulesRes, visitsRes] = await Promise.all([
    supabase
      .schema("maintenance")
      .from("v_tasks_with_context")
      .select("*")
      .in("service_location_id", locIds)
      .order("status", { ascending: true })
      .order("starts_on", { ascending: false }),
    supabase
      .schema("maintenance")
      .from("v_task_schedules_with_context")
      .select("*")
      .in("service_location_id", locIds)
      .order("active", { ascending: false })
      .order("day_of_week", { ascending: true, nullsFirst: false }),
    supabase
      .schema("maintenance")
      .from("v_visits_with_context")
      .select("*")
      .in("service_location_id", locIds)
      .order("visit_date", { ascending: false })
      .limit(150),
  ])

  const tasks = (tasksRes.data ?? []) as TaskContextRow[]
  const schedules = (schedulesRes.data ?? []) as TaskScheduleContextRow[]
  const visits = (visitsRes.data ?? []) as VisitContextRow[]
  const taskIds = tasks.map((t) => t.id)
  const scheduleIds = schedules.map((s) => s.id)

  const audit: MaintenanceCustomerDetail["audit"] = []
  if (taskIds.length > 0) {
    const { data: ta } = await supabase
      .schema("maintenance")
      .from("tasks_audit")
      .select("id, task_id, changed_at, operation, diff")
      .in("task_id", taskIds)
      .order("changed_at", { ascending: false })
      .limit(60)
    for (const r of ta ?? []) {
      audit.push({
        kind: "task",
        id: Number(r.id),
        target_id: r.task_id as string,
        changed_at: r.changed_at as string,
        operation: r.operation as string,
        diff: (r.diff as Record<string, unknown>) ?? null,
      })
    }
  }
  if (scheduleIds.length > 0) {
    const { data: sa } = await supabase
      .schema("maintenance")
      .from("task_schedules_audit")
      .select("id, task_schedule_id, changed_at, operation, diff")
      .in("task_schedule_id", scheduleIds)
      .order("changed_at", { ascending: false })
      .limit(120)
    for (const r of sa ?? []) {
      audit.push({
        kind: "schedule",
        id: Number(r.id),
        target_id: r.task_schedule_id as string,
        changed_at: r.changed_at as string,
        operation: r.operation as string,
        diff: (r.diff as Record<string, unknown>) ?? null,
      })
    }
  }
  audit.sort((a, b) => (a.changed_at < b.changed_at ? 1 : -1))

  return {
    customer: cust as MaintenanceCustomerDetail["customer"],
    service_locations: locations,
    tasks,
    schedules,
    visits,
    audit,
  }
}

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const
