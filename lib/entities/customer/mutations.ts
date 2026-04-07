import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { Customer } from "./types"
import { assertCustomerRules } from "./rules"
import { getCustomer } from "./queries"

/**
 * Update a customer. THE ONLY WAY to write to customer-related tables.
 *
 * Funnels through:
 *   1. Load current state
 *   2. Validate invariants
 *   3. Write
 *   4. Audit (TODO when audit table exists)
 *   5. Emit event (TODO)
 *   6. Bust caches
 */
export async function updateCustomer(id: string, patch: Partial<Customer>) {
  const current = await getCustomer(id)
  if (!current) throw new Error(`Customer ${id} not found`)

  assertCustomerRules(current, patch)

  const supabase = await createSupabaseServer()
  const writable: Record<string, unknown> = {}
  if (patch.display_name !== undefined) writable.display_name = patch.display_name
  if (patch.email !== undefined) writable.email = patch.email
  if (patch.phone !== undefined) writable.phone = patch.phone
  if (patch.is_active !== undefined) writable.is_active = patch.is_active

  const { error } = await supabase.from("Customers").update(writable).eq("id", id)
  if (error) throw error

  revalidatePath(`/customers/${id}`)
  revalidatePath("/customers")

  return getCustomer(id)
}
