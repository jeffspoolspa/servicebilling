import { createSupabaseServer } from "@/lib/supabase/server"
import type { SignOutRowInput } from "./types"

/**
 * Insert one submission's worth of sign-out rows. Relies on RLS to ensure the
 * employee_id matches the caller's auth_user_id.
 */
export async function createSignOuts(
  employeeId: string,
  rows: SignOutRowInput[],
): Promise<void> {
  if (rows.length === 0) return
  const supabase = await createSupabaseServer()
  const payload = rows.map((r) => ({
    employee_id: employeeId,
    item_id: r.item_id,
    quantity: r.quantity,
  }))
  const { error } = await supabase.from("inventory_sign_outs").insert(payload)
  if (error) throw error
}
