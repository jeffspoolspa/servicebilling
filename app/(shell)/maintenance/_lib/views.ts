import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Module-private query helpers backed by the maintenance.v_* views.
 *
 * The views denormalize customer/service-location/employee display info onto
 * each row so pages can render flat tables without doing client-side joins
 * or fragile multi-FK PostgREST embeds.
 */

export interface VisitContextRow {
  id: string
  service_location_id: number
  task_id: string | null
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
  snapshot_frequency: string | null
  work_order_wo_number: string | null
  ion_work_order_id: string | null
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
  tech_employee_id: string | null
  day_of_week: number | null
  frequency: string | null
  price_per_visit_cents: number | null
  chem_budget_cents: number | null
  sequence: number | null
  status: "active" | "paused" | "closed"
  pause_reason: string | null
  starts_on: string
  ends_on: string | null
  notes: string | null
  ion_task_id: string | null
  service_location_street: string | null
  service_location_city: string | null
  customer_id: number | null
  customer_name: string | null
  tech_name: string | null
}

export interface RouteSummaryRow {
  tech_employee_id: string
  tech_name: string | null
  day_of_week: number
  stop_count: number
  total_price_cents: number | null
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
): Promise<TaskContextRow[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_tasks_with_context")
    .select("*")
    .eq("status", "active")
    .eq("tech_employee_id", techEmployeeId)
    .eq("day_of_week", dayOfWeek)
    .order("sequence", { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as unknown as TaskContextRow[]
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

  // Compute date bounds in JS — Postgres now() in the DB might be UTC.
  const today = new Date().toISOString().slice(0, 10)
  const sunday = new Date()
  sunday.setDate(sunday.getDate() - sunday.getDay()) // Sunday this week
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

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const
