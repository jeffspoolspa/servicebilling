"use server"

import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

/**
 * Office is an attribute of the CUSTOMER (ADR 007 §9): geography-derived from the service
 * address, but manually overridable. set_customer_office locks a manual choice (sticky — the
 * auto-recompute trigger skips it); clear_customer_office_override releases it back to geography.
 */
export async function setCustomerOffice(
  customerId: number,
  officeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return { ok: false, error: "unauthorized" }
  const { error } = await sb.rpc("set_customer_office", {
    p_customer_id: customerId,
    p_office_id: officeId,
    p_user: user.id,
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/maintenance/customers/${customerId}`)
  revalidatePath("/maintenance/customers")
  return { ok: true }
}

export async function clearCustomerOfficeOverride(
  customerId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return { ok: false, error: "unauthorized" }
  const { error } = await sb.rpc("clear_customer_office_override", { p_customer_id: customerId })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/maintenance/customers/${customerId}`)
  revalidatePath("/maintenance/customers")
  return { ok: true }
}
