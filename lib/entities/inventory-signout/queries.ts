import { createSupabaseServer } from "@/lib/supabase/server"
import type { SignOutItem } from "./types"
import { SIGNOUT_ITEM_IDS, getSignOutConfig } from "./signout-items"

/**
 * Items the tech can pick from in the sign-out form. Driven by the allowlist
 * in signout-items.ts — not a generic "all items" query.
 */
export async function listSignOutItems(): Promise<SignOutItem[]> {
  if (SIGNOUT_ITEM_IDS.length === 0) return []
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .from("items")
    .select("id, sku, item_name")
    .in("id", SIGNOUT_ITEM_IDS)
    .order("item_name", { ascending: true })
  return (data ?? [])
    .map((row) => {
      const cfg = getSignOutConfig(row.id as number)
      const itemName = (row.item_name as string | null) ?? null
      return {
        id: row.id as number,
        sku: (row.sku as string | null) ?? null,
        item_name: itemName,
        display_name: cfg?.displayName ?? itemName ?? `Item #${row.id}`,
        category: cfg?.category ?? "chemical",
        multiplier: cfg?.multiplier ?? 1,
        input_unit: cfg?.inputUnit ?? null,
        stock_unit: cfg?.stockUnit ?? null,
      }
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
}
