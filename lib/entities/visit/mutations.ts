import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { SnapshotFrequency, Visit, VisitStatus, VisitType } from "./types"
import { assertValidStatusTransition, assertVisitRules } from "./rules"
import { getVisit } from "./queries"

const WRITABLE_FIELDS = [
  "actual_tech_id",
  "visit_date",
  "scheduled_start",
  "started_at",
  "ended_at",
  "notes",
  "work_order_id",
  "price_cents",
] as const

/**
 * Insert an ad-hoc visit (QC, service call, repair, makeup). Generated route
 * visits flow in via the Windmill generator, not this entry point.
 */
export async function createAdHocVisit(input: {
  service_location_id: string
  visit_date: string
  scheduled_date?: string
  visit_type: Exclude<VisitType, "route">
  scheduled_tech_id?: string | null
  actual_tech_id?: string | null
  price_cents?: number | null
  notes?: string | null
  ion_work_order_id?: string | null
  skimmer_visit_id?: string | null
  external_source?: string | null
}): Promise<Visit> {
  const supabase = await createSupabaseServer()
  const scheduled_date = input.scheduled_date ?? input.visit_date
  const { data, error } = await supabase
    .schema("maintenance")
    .from("visits")
    .insert({
      service_location_id: input.service_location_id,
      task_id: null,
      scheduled_date,
      visit_date: input.visit_date,
      scheduled_tech_id: input.scheduled_tech_id ?? input.actual_tech_id ?? null,
      actual_tech_id: input.actual_tech_id ?? input.scheduled_tech_id ?? null,
      visit_type: input.visit_type,
      status: "scheduled",
      price_cents: input.price_cents ?? null,
      snapshot_frequency: null,
      notes: input.notes ?? null,
      ion_work_order_id: input.ion_work_order_id ?? null,
      skimmer_visit_id: input.skimmer_visit_id ?? null,
      external_source: input.external_source ?? "manual",
    })
    .select("*")
    .single()
  if (error || !data) throw error ?? new Error("createAdHocVisit: no row returned")
  revalidatePath("/maintenance")
  const visit = await getVisit(data.id as string)
  if (!visit) throw new Error("createAdHocVisit: failed to reload visit")
  return visit
}

/**
 * Generic patch for a visit. Use named helpers below for status transitions
 * and tech reassignment so the right rules fire.
 */
export async function updateVisit(id: string, patch: Partial<Visit>): Promise<Visit | null> {
  const current = await getVisit(id)
  if (!current) throw new Error(`Visit ${id} not found`)

  assertVisitRules(current, patch)

  const supabase = await createSupabaseServer()
  const writable: Record<string, unknown> = {}
  for (const key of WRITABLE_FIELDS) {
    if (patch[key] !== undefined) writable[key] = patch[key]
  }

  if (Object.keys(writable).length === 0) return current

  const { error } = await supabase
    .schema("maintenance")
    .from("visits")
    .update(writable)
    .eq("id", id)
  if (error) throw error

  revalidatePath(`/maintenance/visits/${id}`)
  revalidatePath("/maintenance")
  return getVisit(id)
}

/** Move a visit to a different actual tech (temp swap). */
export async function reassignTech(id: string, actualTechId: string): Promise<Visit | null> {
  return updateVisit(id, { actual_tech_id: actualTechId })
}

/** Move a visit's actual date (reschedule). */
export async function rescheduleVisit(id: string, newVisitDate: string): Promise<Visit | null> {
  return updateVisit(id, { visit_date: newVisitDate })
}

/** Status transition with FSM check. */
export async function setVisitStatus(
  id: string,
  status: VisitStatus,
): Promise<Visit | null> {
  const current = await getVisit(id)
  if (!current) throw new Error(`Visit ${id} not found`)
  assertValidStatusTransition(current, status)

  const patch: Record<string, unknown> = { status }
  // Convenience: stamp started_at / ended_at when entering those states.
  if (status === "in_progress" && !current.started_at) {
    patch.started_at = new Date().toISOString()
  }
  if (status === "completed" && !current.ended_at) {
    patch.ended_at = new Date().toISOString()
  }

  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("visits")
    .update(patch)
    .eq("id", id)
  if (error) throw error

  revalidatePath(`/maintenance/visits/${id}`)
  revalidatePath("/maintenance")
  return getVisit(id)
}

/** Link a billable work order to this visit (called by service-billing flow). */
export async function attachWorkOrder(
  id: string,
  workOrderId: string,
): Promise<Visit | null> {
  return updateVisit(id, { work_order_id: workOrderId })
}

/**
 * Internal — used by the future visit generator. Inserts a row with snapshots
 * locked from the source task. Idempotent via the
 * (service_location_id, scheduled_date) unique index.
 */
export async function generateRouteVisit(input: {
  service_location_id: string
  task_id: string
  scheduled_date: string
  scheduled_tech_id: string | null
  scheduled_start?: string | null
  price_cents: number | null
  snapshot_frequency: SnapshotFrequency | null
  external_source?: string
}): Promise<Visit | null> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("visits")
    .upsert(
      {
        service_location_id: input.service_location_id,
        task_id: input.task_id,
        scheduled_date: input.scheduled_date,
        visit_date: input.scheduled_date,
        scheduled_tech_id: input.scheduled_tech_id,
        actual_tech_id: input.scheduled_tech_id,
        scheduled_start: input.scheduled_start ?? null,
        status: "scheduled",
        visit_type: "route",
        price_cents: input.price_cents,
        snapshot_frequency: input.snapshot_frequency,
        external_source: input.external_source ?? "generator",
      },
      { onConflict: "service_location_id,scheduled_date", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return getVisit(data.id as string)
}
