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
 */
export async function editServiceLocationAddress(
  locationId: number,
  customerId: number,
  picked: PickedAddress,
): Promise<{ ok: true } | { ok: false; error: string }> {
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
    if (res.reason === "duplicate") {
      return {
        ok: false,
        error: `That address already exists as service location #${res.existing_location_id}. The pool may need to be repointed to it instead of edited here.`,
      }
    }
    return { ok: false, error: res.reason ?? "edit failed" }
  }

  revalidatePath(`/maintenance/customers/${customerId}`)
  revalidatePath("/maintenance/routes/map")
  return { ok: true }
}
