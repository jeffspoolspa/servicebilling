// Browser-safe half of the follow-up entity: constants, types, and the
// client-side history fetch. No next/headers imports here — client components
// (FollowUpForm) import from this file, not from index.ts.
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * Issue options for a field follow-up. Must stay in sync with the CHECK
 * constraint on maintenance.follow_ups.issue (migration 20260713173327) and
 * match choices on the Airtable "Maintenance Follow up" Issue single-select
 * (the sync posts with typecast:true, so new values would auto-create there).
 */
export const FOLLOW_UP_ISSUES = [
  "Equipment Issue",
  "Green Pool",
  "Zero Chlorine",
  "Chemical Refill",
  "Water Chemistry",
  "Re-Schedule Clean",
  "Access / Site Conditions",
  "Unserviceable",
  "Other",
] as const

export type FollowUpIssue = (typeof FOLLOW_UP_ISSUES)[number]

export interface ActiveCustomer {
  customer_id: number
  customer_name: string
  address: string | null
  phone: string | null
}

export interface CustomerFollowUp {
  id: string
  created_at: string
  issue: string
  description: string
  status: "open" | "closed"
  equipment_off: boolean | null
  tech_name: string | null
}

export interface FollowUpMedia {
  path: string
  type: "image" | "video"
}

/** A row in the tech's own follow-up history (list_my_follow_ups). */
export interface MyFollowUp {
  id: string
  created_at: string
  issue: string
  description: string
  status: "open" | "closed"
  customer_name: string
  media_count: number
}

/** A customer's follow-up history — fetched client-side on selection. */
export async function listCustomerFollowUpsBrowser(
  customerId: number,
): Promise<CustomerFollowUp[]> {
  const supabase = createSupabaseBrowser()
  const { data, error } = await supabase.rpc("list_customer_follow_ups", {
    p_customer_id: customerId,
  })
  if (error) throw error
  return (data ?? []) as CustomerFollowUp[]
}
