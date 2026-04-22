import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { getSignOutConfig } from "./signout-items"

export interface TodaysSignOut {
  id: number
  item_id: number
  quantity: number
  signed_out_at: string
  updated_at: string
  item_name: string | null
  sku: string | null
  /** Computed client-side from the allowlist config for presentation. */
  display_name: string
  input_unit: string | null
  stock_unit: string | null
  multiplier: number
}

function enrich(row: Record<string, unknown>): TodaysSignOut {
  const itemId = row.item_id as number
  const cfg = getSignOutConfig(itemId)
  const itemName = (row.item_name as string | null) ?? null
  return {
    id: row.id as number,
    item_id: itemId,
    quantity: Number(row.quantity ?? 0),
    signed_out_at: row.signed_out_at as string,
    updated_at: row.updated_at as string,
    item_name: itemName,
    sku: (row.sku as string | null) ?? null,
    display_name: cfg?.displayName ?? itemName ?? `Item #${itemId}`,
    input_unit: cfg?.inputUnit ?? null,
    stock_unit: cfg?.stockUnit ?? null,
    multiplier: cfg?.multiplier ?? 1,
  }
}

/** Server-side fetch of the caller's own sign-outs for today (Eastern). */
export async function listTodaysSignOuts(): Promise<TodaysSignOut[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.rpc("list_my_todays_sign_outs")
  if (error) throw error
  return ((data ?? []) as Array<Record<string, unknown>>).map(enrich)
}

/** Browser-side fetch — used to refresh the list after an edit/delete. */
export async function listTodaysSignOutsBrowser(): Promise<TodaysSignOut[]> {
  const supabase = createSupabaseBrowser()
  const { data, error } = await supabase.rpc("list_my_todays_sign_outs")
  if (error) throw error
  return ((data ?? []) as Array<Record<string, unknown>>).map(enrich)
}
