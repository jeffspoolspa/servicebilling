import { createSupabaseServer } from "@/lib/supabase/server"
import type { Pool, PoolKind, PoolSanitizer, PoolSurface } from "./types"

export async function getPool(id: string): Promise<Pool | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.from("pools").select("*").eq("id", id).single()
  if (!data) return null
  return enrich(data)
}

export async function listPoolsForServiceLocation(
  serviceLocationId: string,
  opts?: { activeOnly?: boolean },
): Promise<Pool[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .from("pools")
    .select("*")
    .eq("service_location_id", serviceLocationId)
    .order("kind", { ascending: true })
    .order("name", { ascending: true })

  if (opts?.activeOnly) query = query.eq("active", true)

  const { data } = await query
  return (data ?? []).map(enrich)
}

export async function listPools(opts?: { activeOnly?: boolean; limit?: number }): Promise<Pool[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .from("pools")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 100)

  if (opts?.activeOnly) query = query.eq("active", true)

  const { data } = await query
  return (data ?? []).map(enrich)
}

function enrich(row: Record<string, unknown>): Pool {
  return {
    id: row.id as string,
    service_location_id: row.service_location_id as string,
    name: (row.name as string) ?? null,
    kind: (row.kind as PoolKind) ?? null,
    gallons: row.gallons === null || row.gallons === undefined ? null : Number(row.gallons),
    surface: (row.surface as PoolSurface) ?? null,
    sanitizer: (row.sanitizer as PoolSanitizer) ?? null,
    active: Boolean(row.active),
    seasonal_close_from: (row.seasonal_close_from as string) ?? null,
    seasonal_close_to: (row.seasonal_close_to as string) ?? null,
    skimmer_id: (row.skimmer_id as string) ?? null,
    ion_pool_id: (row.ion_pool_id as string) ?? null,
    external_source: (row.external_source as string) ?? null,
    notes: (row.notes as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
