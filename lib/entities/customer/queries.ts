import { createSupabaseServer } from "@/lib/supabase/server"
import type { Customer } from "./types"

/**
 * Load a customer by id, joining all related tables.
 * The only function the rest of the app should use to read a customer.
 */
export async function getCustomer(id: string): Promise<Customer | null> {
  const supabase = await createSupabaseServer()

  const { data, error } = await supabase
    .from("Customers")
    .select(
      `
      *,
      service_locations(*)
      `,
    )
    .eq("id", id)
    .single()

  if (error || !data) return null
  return enrichCustomer(data)
}

export async function listCustomers(opts?: {
  search?: string
  limit?: number
}): Promise<Customer[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .from("Customers")
    .select("*")
    .order("display_name", { ascending: true })
    .limit(opts?.limit ?? 50)

  if (opts?.search) {
    query = query.ilike("display_name", `%${opts.search}%`)
  }

  const { data } = await query
  return (data ?? []).map(enrichCustomer)
}

/**
 * Enrich a raw row into the Customer entity. Adds computed fields.
 * This is the only place that knows how to assemble a Customer.
 */
function enrichCustomer(row: Record<string, unknown>): Customer {
  return {
    id: row.id as string,
    qbo_customer_id: (row.qbo_customer_id as string) ?? null,
    display_name: (row.display_name as string) ?? "",
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    is_active: (row.is_active as boolean) ?? true,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    service_locations: (row.service_locations as Customer["service_locations"]) ?? [],
    payment_methods: [],
    billing_preferences: null,
    open_balance: 0,
    is_autopay: false,
    last_service_date: null,
  }
}
