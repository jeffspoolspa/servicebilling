// Server half of the follow-up entity. Client components must import from
// ./shared instead (this file pulls in next/headers via createSupabaseServer).
import { createSupabaseServer } from "@/lib/supabase/server"
import type { ActiveCustomer, FollowUpIssue, FollowUpMedia, MyFollowUp } from "./shared"

export * from "./shared"

/** Customers with an active recurring maintenance task (server-side). */
export async function listActiveCustomers(): Promise<ActiveCustomer[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.rpc("list_active_maintenance_customers")
  if (error) throw error
  return (data ?? []) as ActiveCustomer[]
}

/** The logged-in tech's own submitted follow-ups (server-side). */
export async function listMyFollowUps(): Promise<MyFollowUp[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.rpc("list_my_follow_ups")
  if (error) throw error
  return (data ?? []) as MyFollowUp[]
}

/**
 * Insert one follow-up ticket. RLS ensures tech_employee_id matches the
 * caller. The row itself is the Airtable outbox — an AFTER INSERT trigger
 * wakes f/maintenance/sync_follow_ups_to_airtable.
 */
export async function createFollowUp(row: {
  tech_employee_id: string
  customer_id: number
  issue: FollowUpIssue
  description: string
  media: FollowUpMedia[]
  equipment_off: boolean | null
}): Promise<void> {
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("follow_ups")
    .insert(row)
  if (error) throw error
}
