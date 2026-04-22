import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
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

/**
 * Update the quantity on one of the caller's own sign-outs, limited by RLS
 * to rows that were created today (Eastern).
 */
export async function updateSignOutQuantity(id: number, quantity: number): Promise<void> {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be positive.")
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .from("inventory_sign_outs")
    .update({ quantity })
    .eq("id", id)
  if (error) throw error
  revalidatePath("/sign-out")
}

/** Delete one of the caller's own sign-outs (RLS limits to today-only). */
export async function deleteSignOut(id: number): Promise<void> {
  const supabase = await createSupabaseServer()
  const { error } = await supabase.from("inventory_sign_outs").delete().eq("id", id)
  if (error) throw error
  revalidatePath("/sign-out")
}
