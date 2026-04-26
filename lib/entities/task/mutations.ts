import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { DayOfWeek, Task, TaskFrequency } from "./types"
import { assertTaskRules, assertValidStatusTransition } from "./rules"
import { getTask } from "./queries"

const WRITABLE_FIELDS = [
  "tech_employee_id",
  "day_of_week",
  "frequency",
  "price_per_visit_cents",
  "chem_budget_cents",
  "included_items",
  "sequence",
  "notes",
  "ends_on",
] as const

/**
 * Create a new task for a service location. The "one open task per location"
 * partial unique index will reject if there's already an active or paused
 * task — caller should close the old one first.
 */
export async function createTask(input: {
  service_location_id: string
  tech_employee_id?: string | null
  day_of_week?: DayOfWeek | null
  frequency?: TaskFrequency | null
  price_per_visit_cents?: number | null
  chem_budget_cents?: number | null
  sequence?: number | null
  starts_on?: string
  notes?: string | null
  skimmer_id?: string | null
  external_source?: string | null
}): Promise<Task> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("tasks")
    .insert({
      service_location_id: input.service_location_id,
      tech_employee_id: input.tech_employee_id ?? null,
      day_of_week: input.day_of_week ?? null,
      frequency: input.frequency ?? null,
      price_per_visit_cents: input.price_per_visit_cents ?? null,
      chem_budget_cents: input.chem_budget_cents ?? null,
      sequence: input.sequence ?? null,
      starts_on: input.starts_on ?? new Date().toISOString().slice(0, 10),
      notes: input.notes ?? null,
      skimmer_id: input.skimmer_id ?? null,
      external_source: input.external_source ?? "manual",
      status: "active",
    })
    .select("*")
    .single()
  if (error || !data) throw error ?? new Error("createTask: no row returned")
  revalidatePath("/maintenance")
  const task = await getTask(data.id as string)
  if (!task) throw new Error("createTask: failed to reload task")
  return task
}

/**
 * Generic partial update. Only fields in WRITABLE_FIELDS are applied. Use the
 * named helpers below (`pauseTask`, `closeTask`) for status transitions so
 * the FSM rule fires.
 */
export async function updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
  const current = await getTask(id)
  if (!current) throw new Error(`Task ${id} not found`)

  assertTaskRules(current, patch)

  const supabase = await createSupabaseServer()
  const writable: Record<string, unknown> = {}
  for (const key of WRITABLE_FIELDS) {
    if (patch[key] !== undefined) writable[key] = patch[key]
  }

  if (Object.keys(writable).length === 0) return current

  const { error } = await supabase
    .schema("maintenance")
    .from("tasks")
    .update(writable)
    .eq("id", id)
  if (error) throw error

  revalidatePath(`/maintenance/tasks/${id}`)
  revalidatePath("/maintenance")
  return getTask(id)
}

/** Pause a task (no visits will be generated until reactivated). */
export async function pauseTask(id: string, reason: string | null): Promise<Task | null> {
  const current = await getTask(id)
  if (!current) throw new Error(`Task ${id} not found`)
  assertValidStatusTransition(current, "paused")

  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("tasks")
    .update({ status: "paused", pause_reason: reason })
    .eq("id", id)
  if (error) throw error
  revalidatePath(`/maintenance/tasks/${id}`)
  revalidatePath("/maintenance")
  return getTask(id)
}

/** Reactivate a paused task. */
export async function activateTask(id: string): Promise<Task | null> {
  const current = await getTask(id)
  if (!current) throw new Error(`Task ${id} not found`)
  assertValidStatusTransition(current, "active")

  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("tasks")
    .update({ status: "active", pause_reason: null })
    .eq("id", id)
  if (error) throw error
  revalidatePath(`/maintenance/tasks/${id}`)
  revalidatePath("/maintenance")
  return getTask(id)
}

/**
 * Close a task. Terminal — to resume service to the location, open a new
 * task instead. Sets ends_on to today.
 */
export async function closeTask(id: string): Promise<Task | null> {
  const current = await getTask(id)
  if (!current) throw new Error(`Task ${id} not found`)
  assertValidStatusTransition(current, "closed")

  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("tasks")
    .update({
      status: "closed",
      ends_on: new Date().toISOString().slice(0, 10),
    })
    .eq("id", id)
  if (error) throw error
  revalidatePath(`/maintenance/tasks/${id}`)
  revalidatePath("/maintenance")
  return getTask(id)
}
