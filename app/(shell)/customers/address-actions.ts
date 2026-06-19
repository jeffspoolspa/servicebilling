"use server"

import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

/**
 * Server actions for the customer↔service-address UI (ADR 005). Linking find-or-creates the
 * address by place_id via upsert_service_location; management uses the link-table RPCs.
 * All run as the authed office user.
 */

export interface PickedForLink {
  id: string // google place_id
  street: string
  city: string
  state: string
  zip: string
  lat: number | null
  lng: number | null
}

async function authed() {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  return user ? sb : null
}

/** Is this place_id already in the registry? Who (if anyone) is the active owner there?
 *  Used to warn in the confirm dialog before linking. */
export async function checkAddressRegistry(placeId: string) {
  const sb = await authed()
  if (!sb) return { error: "unauthorized" as const }
  const { data: loc } = await sb
    .from("service_locations")
    .select("id")
    .eq("place_id", placeId)
    .maybeSingle()
  if (!loc) return { exists: false, locationId: null, activeOwners: [] as string[] }
  const { data: links } = await sb
    .from("customer_service_addresses")
    .select("customer_id")
    .eq("service_location_id", loc.id)
    .eq("is_active", true)
  const ids = (links ?? []).map((l) => l.customer_id as number)
  let activeOwners: string[] = []
  if (ids.length) {
    const { data: cs } = await sb.from("Customers").select("display_name").in("id", ids)
    activeOwners = (cs ?? []).map((c) => c.display_name as string).filter(Boolean)
  }
  return { exists: true, locationId: loc.id as number, activeOwners }
}

/** Link a customer to an address (find-or-create by place_id) and make them the active owner. */
export async function linkCustomerToAddress(customerId: number, p: PickedForLink) {
  const sb = await authed()
  if (!sb) return { ok: false as const, error: "unauthorized" }
  const { data, error } = await sb.rpc("upsert_service_location", {
    p_account_id: customerId,
    p_place_id: p.id,
    p_street: p.street,
    p_city: p.city,
    p_state: p.state,
    p_zip: p.zip,
    p_lat: p.lat,
    p_lng: p.lng,
    p_is_primary: true,
    p_geocode_source: "app+autocomplete",
    p_geocode_status: "ok",
  })
  if (error) return { ok: false as const, error: error.message }
  revalidatePath(`/customers/${customerId}`)
  revalidatePath("/customers")
  return { ok: true as const, locationId: data as number }
}

/** Replace a customer's service address: link the new one (find-or-create by place_id), then
 *  remove the old link. Links first so the customer is never left address-less. */
export async function replaceCustomerAddress(
  customerId: number,
  oldLocationId: number,
  p: PickedForLink,
) {
  const sb = await authed()
  if (!sb) return { ok: false as const, error: "unauthorized" }
  const { data: newLoc, error } = await sb.rpc("upsert_service_location", {
    p_account_id: customerId,
    p_place_id: p.id,
    p_street: p.street,
    p_city: p.city,
    p_state: p.state,
    p_zip: p.zip,
    p_lat: p.lat,
    p_lng: p.lng,
    p_is_primary: true,
    p_geocode_source: "app+autocomplete",
    p_geocode_status: "ok",
  })
  if (error) return { ok: false as const, error: error.message }
  if (oldLocationId && oldLocationId !== (newLoc as number)) {
    const { error: unlinkErr } = await sb.rpc("unlink_customer_address", {
      p_customer_id: customerId,
      p_location_id: oldLocationId,
    })
    if (unlinkErr) return { ok: false as const, error: unlinkErr.message, locationId: newLoc as number }
    revalidatePath(`/addresses/${oldLocationId}`)
  }
  revalidatePath(`/customers/${customerId}`)
  revalidatePath("/customers")
  return { ok: true as const, locationId: newLoc as number }
}

/** Make a customer the active owner of an address (active=true demotes others), or deactivate. */
export async function setAddressActive(customerId: number, locationId: number, active: boolean) {
  const sb = await authed()
  if (!sb) return { ok: false as const, error: "unauthorized" }
  const { error } = await sb.rpc("set_customer_address_active", {
    p_customer_id: customerId,
    p_location_id: locationId,
    p_active: active,
  })
  if (error) return { ok: false as const, error: error.message }
  revalidatePath(`/addresses/${locationId}`)
  revalidatePath(`/customers/${customerId}`)
  return { ok: true as const }
}

/** Remove a customer↔address link entirely. */
export async function unlinkAddress(customerId: number, locationId: number) {
  const sb = await authed()
  if (!sb) return { ok: false as const, error: "unauthorized" }
  const { error } = await sb.rpc("unlink_customer_address", {
    p_customer_id: customerId,
    p_location_id: locationId,
  })
  if (error) return { ok: false as const, error: error.message }
  revalidatePath(`/addresses/${locationId}`)
  revalidatePath(`/customers/${customerId}`)
  return { ok: true as const }
}
