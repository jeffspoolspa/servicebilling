import { createSupabaseServer } from "@/lib/supabase/server"
import type { DayOfWeek, Task, TaskFrequency, TaskStatus } from "./types"

export async function getTask(id: string): Promise<Task | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single()
  if (!data) return null
  return enrich(data)
}

/**
 * Look up the active (or active+paused) task for a service location. There's
 * a partial unique index that guarantees at most one such row.
 */
export async function getOpenTaskForServiceLocation(
  serviceLocationId: number,
): Promise<Task | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("tasks")
    .select("*")
    .eq("service_location_id", serviceLocationId)
    .in("status", ["active", "paused"])
    .maybeSingle()
  if (!data) return null
  return enrich(data)
}

export async function listTasks(opts?: {
  status?: TaskStatus
  techEmployeeId?: string
  dayOfWeek?: DayOfWeek
  limit?: number
}): Promise<Task[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .schema("maintenance")
    .from("tasks")
    .select("*")
    .order("sequence", { ascending: true, nullsFirst: false })
    .limit(opts?.limit ?? 500)

  if (opts?.status) query = query.eq("status", opts.status)
  if (opts?.techEmployeeId) query = query.eq("tech_employee_id", opts.techEmployeeId)
  if (opts?.dayOfWeek !== undefined) query = query.eq("day_of_week", opts.dayOfWeek)

  const { data } = await query
  return (data ?? []).map(enrich)
}

/**
 * Derived "route" view — the active tasks for one (tech, day) pair. There is
 * NO routes table; routes are computed by grouping tasks like this.
 */
export async function listRouteStops(
  techEmployeeId: string,
  dayOfWeek: DayOfWeek,
): Promise<Task[]> {
  return listTasks({
    status: "active",
    techEmployeeId,
    dayOfWeek,
    limit: 500,
  })
}

function enrich(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    service_location_id: Number(row.service_location_id),
    tech_employee_id: (row.tech_employee_id as string) ?? null,
    day_of_week: (row.day_of_week as Task["day_of_week"]) ?? null,
    frequency: (row.frequency as TaskFrequency) ?? null,
    price_per_visit_cents:
      row.price_per_visit_cents === null || row.price_per_visit_cents === undefined
        ? null
        : Number(row.price_per_visit_cents),
    chem_budget_cents:
      row.chem_budget_cents === null || row.chem_budget_cents === undefined
        ? null
        : Number(row.chem_budget_cents),
    included_items: row.included_items ?? null,
    sequence:
      row.sequence === null || row.sequence === undefined ? null : Number(row.sequence),
    status: (row.status as TaskStatus) ?? "active",
    pause_reason: (row.pause_reason as string) ?? null,
    starts_on: row.starts_on as string,
    ends_on: (row.ends_on as string) ?? null,
    notes: (row.notes as string) ?? null,
    skimmer_id: (row.skimmer_id as string) ?? null,
    external_source: (row.external_source as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
