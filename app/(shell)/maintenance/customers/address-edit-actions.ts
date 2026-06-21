"use server"

import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { PickedAddress } from "@/components/form/mapbox-address-autocomplete"

/**
 * Correct a service_location's address in place (ADR 007). Used from the maintenance
 * customer page to fix a wrong service address (e.g. an ION-mislabeled Sea Island pool
 * recorded as Savannah). Edits the existing row via edit_service_location_address, so the
 * tasks/visits/route map that reference it all update — unlike the relink flow, which would
 * leave tasks.service_location_id pointing at the old row.
 *
 * When the picked address ALREADY exists as another canonical location (the editor's old
 * "replace" flow created a clean row but never repointed the tasks — the O'BRIEN case), the
 * edit can't proceed (place_id is unique). Instead of dead-ending, it surfaces the existing
 * location so the UI can offer a merge (mergeServiceLocationIntoExisting).
 */

type EditResult =
  | { ok: true }
  | { ok: false; error: string; duplicateOf?: number; duplicateLabel?: string }

export async function editServiceLocationAddress(
  locationId: number,
  customerId: number,
  picked: PickedAddress,
): Promise<EditResult> {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return { ok: false, error: "unauthorized" }

  const { data, error } = await sb.rpc("edit_service_location_address", {
    p_location_id: locationId,
    p_place_id: picked.id,
    p_street: picked.street,
    p_city: picked.city,
    p_state: picked.state,
    p_zip: picked.zip,
    p_lat: picked.lat,
    p_lng: picked.lng,
  })
  if (error) return { ok: false, error: error.message }

  const res = data as { ok: boolean; reason?: string; existing_location_id?: number }
  if (!res.ok) {
    if (res.reason === "duplicate" && res.existing_location_id) {
      const { data: loc } = await sb
        .from("service_locations")
        .select("street, city")
        .eq("id", res.existing_location_id)
        .maybeSingle()
      const label = loc ? [loc.street, loc.city].filter(Boolean).join(", ") : `#${res.existing_location_id}`
      return {
        ok: false,
        duplicateOf: res.existing_location_id,
        duplicateLabel: label,
        error: `This address already exists as another service location (${label}).`,
      }
    }
    return { ok: false, error: res.reason ?? "edit failed" }
  }

  revalidatePath(`/maintenance/customers/${customerId}`)
  revalidatePath("/maintenance/routes/map")
  revalidatePath("/maintenance")
  return { ok: true }
}

/**
 * Merge a duplicate service_location onto an existing canonical one (ADR 007): repoint this
 * customer's tasks/visits/pools/link from the duplicate onto the canonical row, then retire the
 * duplicate. Resolves the "tasks stuck on the raw row while a correct row exists" case. The RPC
 * refuses if the source carries tasks for more than one customer (a shared junk SL) — that needs
 * manual untangling, and the raised message is surfaced.
 */
export async function mergeServiceLocationIntoExisting(
  fromLocationId: number,
  intoLocationId: number,
  customerId: number,
): Promise<{ ok: true; tasksMoved: number; visitsMoved: number } | { ok: false; error: string }> {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return { ok: false, error: "unauthorized" }

  const { data, error } = await sb.rpc("merge_service_location", {
    p_from: fromLocationId,
    p_into: intoLocationId,
  })
  if (error) return { ok: false, error: error.message }

  const res = data as { ok: boolean; tasks_moved?: number; visits_moved?: number }
  if (!res.ok) return { ok: false, error: "merge failed" }

  revalidatePath(`/maintenance/customers/${customerId}`)
  revalidatePath("/maintenance/routes/map")
  revalidatePath("/maintenance")
  return { ok: true, tasksMoved: res.tasks_moved ?? 0, visitsMoved: res.visits_moved ?? 0 }
}
