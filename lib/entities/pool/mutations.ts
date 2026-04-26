import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { Pool } from "./types"
import { assertPoolRules } from "./rules"
import { getPool } from "./queries"

const WRITABLE_FIELDS = [
  "name",
  "kind",
  "gallons",
  "surface",
  "sanitizer",
  "active",
  "seasonal_close_from",
  "seasonal_close_to",
  "notes",
] as const

/**
 * Create a new pool tied to a service location. Returns the created pool.
 */
export async function createPool(
  input: Omit<
    Pool,
    "id" | "created_at" | "updated_at" | "skimmer_id" | "ion_pool_id" | "external_source"
  > & {
    skimmer_id?: string | null
    ion_pool_id?: string | null
    external_source?: string | null
  },
): Promise<Pool> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .from("pools")
    .insert({
      service_location_id: input.service_location_id,
      name: input.name,
      kind: input.kind,
      gallons: input.gallons,
      surface: input.surface,
      sanitizer: input.sanitizer,
      active: input.active ?? true,
      seasonal_close_from: input.seasonal_close_from,
      seasonal_close_to: input.seasonal_close_to,
      skimmer_id: input.skimmer_id ?? null,
      ion_pool_id: input.ion_pool_id ?? null,
      external_source: input.external_source ?? "manual",
      notes: input.notes,
    })
    .select("*")
    .single()
  if (error || !data) throw error ?? new Error("createPool: no row returned")
  revalidatePath(`/customers/${input.service_location_id}`)
  revalidatePath("/maintenance")
  const pool = await getPool(data.id as string)
  if (!pool) throw new Error("createPool: failed to reload pool")
  return pool
}

/**
 * Update a pool. Only WRITABLE_FIELDS in the patch are applied.
 */
export async function updatePool(id: string, patch: Partial<Pool>): Promise<Pool | null> {
  const current = await getPool(id)
  if (!current) throw new Error(`Pool ${id} not found`)

  assertPoolRules(current, patch)

  const supabase = await createSupabaseServer()
  const writable: Record<string, unknown> = {}
  for (const key of WRITABLE_FIELDS) {
    if (patch[key] !== undefined) writable[key] = patch[key]
  }

  if (Object.keys(writable).length === 0) return current

  const { error } = await supabase.from("pools").update(writable).eq("id", id)
  if (error) throw error

  revalidatePath(`/maintenance/pools/${id}`)
  revalidatePath("/maintenance")
  return getPool(id)
}
