/**
 * Office directory — a read model, not a domain concept.
 *
 * D4: a route has no office. Office belongs to the customer, and routing only
 * ever reads it to label and to filter. This module is the one place that
 * fetches the list, so no page hard-codes office names again (the old
 * HOME_OFFICES constant did, and drifts the moment a branch opens or closes).
 */

import { Pin } from "@/lib/routing/domain"
import type { QueryClient } from "./supabase-quota-repository"

export interface Office {
  id: string
  /** Full branch name as stored, e.g. "Richmond Hill, GA". */
  name: string
  /** Geographic label used everywhere in the UI, e.g. "Richmond Hill" (ADR 007). */
  label: string
  /** The branch's geocoded pin — the base the planner anchors slots to. */
  lat: number | null
  lng: number | null
}

export async function listOffices(client: QueryClient): Promise<Office[]> {
  const { data, error } = await client
    .from("branches")
    .select("id, name, latitude, longitude")
    .eq("active", true)
    .range(0, 999)
  if (error) throw new Error(`listOffices: ${JSON.stringify(error)}`)
  return ((data ?? []) as { id: string; name: string; latitude: number | null; longitude: number | null }[])
    .map((b) => {
      const label = b.name.split(",")[0].trim()
      return { id: b.id, name: b.name, label, lat: b.latitude, lng: b.longitude }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Each tech's day anchor: their branch's geocoded pin. The stems (base to
 * first stop, last stop back) are real road every run pays — a route priced
 * without them undercounts, and consolidation looks free.
 */
export async function listTechBases(client: QueryClient): Promise<Map<string, Pin>> {
  const [{ data: branches, error: be }, { data: employees, error: ee }] = await Promise.all([
    client.from("branches").select("id, latitude, longitude").eq("active", true).range(0, 99),
    client.from("employees").select("id, branch_id").range(0, 1999),
  ])
  if (be) throw new Error(`listTechBases branches: ${JSON.stringify(be)}`)
  if (ee) throw new Error(`listTechBases employees: ${JSON.stringify(ee)}`)
  const branchPin = new Map<string, Pin>()
  for (const b of (branches ?? []) as { id: string; latitude: number | null; longitude: number | null }[]) {
    if (b.latitude !== null && b.longitude !== null) branchPin.set(b.id, Pin.restore(b.latitude, b.longitude))
  }
  const bases = new Map<string, Pin>()
  for (const e of (employees ?? []) as { id: string; branch_id: string | null }[]) {
    const pin = e.branch_id ? branchPin.get(e.branch_id) : undefined
    if (pin) bases.set(e.id, pin)
  }
  return bases
}
