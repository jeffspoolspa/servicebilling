import { createSupabaseServer } from "@/lib/supabase/server"
import type { Task, TaskStatus } from "./types"

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
  limit?: number
}): Promise<Task[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .schema("maintenance")
    .from("tasks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 500)

  if (opts?.status) query = query.eq("status", opts.status)

  const { data } = await query
  return (data ?? []).map(enrich)
}

function enrich(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    service_location_id: Number(row.service_location_id),
    chem_budget_cents:
      row.chem_budget_cents === null || row.chem_budget_cents === undefined
        ? null
        : Number(row.chem_budget_cents),
    included_items: row.included_items ?? null,
    status: (row.status as TaskStatus) ?? "active",
    pause_reason: (row.pause_reason as string) ?? null,
    starts_on: row.starts_on as string,
    ends_on: (row.ends_on as string) ?? null,
    notes: (row.notes as string) ?? null,
    external_source: (row.external_source as string) ?? null,
    external_data: (row.external_data as Record<string, unknown>) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
