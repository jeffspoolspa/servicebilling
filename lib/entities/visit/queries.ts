import { createSupabaseServer } from "@/lib/supabase/server"
import type {
  SnapshotFrequency,
  Visit,
  VisitStatus,
  VisitType,
} from "./types"

export async function getVisit(id: string): Promise<Visit | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("visits")
    .select("*")
    .eq("id", id)
    .single()
  if (!data) return null
  return enrich(data)
}

export async function listVisits(opts?: {
  fromDate?: string
  toDate?: string
  techEmployeeId?: string
  status?: VisitStatus
  visitType?: VisitType
  serviceLocationId?: number
  limit?: number
}): Promise<Visit[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .schema("maintenance")
    .from("visits")
    .select("*")
    .order("visit_date", { ascending: false })
    .order("scheduled_start", { ascending: true, nullsFirst: false })
    .limit(opts?.limit ?? 200)

  if (opts?.fromDate) query = query.gte("visit_date", opts.fromDate)
  if (opts?.toDate) query = query.lte("visit_date", opts.toDate)
  if (opts?.techEmployeeId) query = query.eq("actual_tech_id", opts.techEmployeeId)
  if (opts?.status) query = query.eq("status", opts.status)
  if (opts?.visitType) query = query.eq("visit_type", opts.visitType)
  if (opts?.serviceLocationId) query = query.eq("service_location_id", opts.serviceLocationId)

  const { data } = await query
  return (data ?? []).map(enrich)
}

/**
 * "Today's route for tech X" — derived view, no routes table.
 */
export async function listVisitsForRoute(
  techEmployeeId: string,
  visitDate: string,
): Promise<Visit[]> {
  // unchanged signature; service_location_id type changed elsewhere
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("visits")
    .select("*")
    .eq("actual_tech_id", techEmployeeId)
    .eq("visit_date", visitDate)
    .order("scheduled_start", { ascending: true, nullsFirst: false })
  return (data ?? []).map(enrich)
}

function enrich(row: Record<string, unknown>): Visit {
  const scheduled_date = row.scheduled_date as string
  const visit_date = row.visit_date as string
  const scheduled_tech_id = (row.scheduled_tech_id as string) ?? null
  const actual_tech_id = (row.actual_tech_id as string) ?? null

  const is_manually_reassigned =
    visit_date !== scheduled_date ||
    (actual_tech_id !== null &&
      scheduled_tech_id !== null &&
      actual_tech_id !== scheduled_tech_id)

  return {
    id: row.id as string,
    service_location_id: Number(row.service_location_id),
    task_id: (row.task_id as string) ?? null,
    scheduled_date,
    visit_date,
    scheduled_tech_id,
    actual_tech_id,
    scheduled_start: (row.scheduled_start as string) ?? null,
    started_at: (row.started_at as string) ?? null,
    ended_at: (row.ended_at as string) ?? null,
    status: (row.status as VisitStatus) ?? "scheduled",
    visit_type: (row.visit_type as VisitType) ?? "route",
    price_cents:
      row.price_cents === null || row.price_cents === undefined
        ? null
        : Number(row.price_cents),
    snapshot_frequency: (row.snapshot_frequency as SnapshotFrequency) ?? null,
    work_order_wo_number: (row.work_order_wo_number as string) ?? null,
    ion_work_order_id: (row.ion_work_order_id as string) ?? null,
    skimmer_visit_id: (row.skimmer_visit_id as string) ?? null,
    external_source: (row.external_source as string) ?? null,
    notes: (row.notes as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    is_manually_reassigned,
  }
}
