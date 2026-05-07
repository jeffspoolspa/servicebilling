"use server"

import { revalidatePath } from "next/cache"
import { createSupabaseServer } from "@/lib/supabase/server"

export type ActionState = { ok?: string; error?: string }

/**
 * Mark a single drift_log row resolved. Used by the per-row "Dismiss" button.
 *
 * The reconciler does not currently auto-clear drift entries when the cache
 * catches up to QBO — those rows accumulate as stale alerts. This RPC is the
 * manual escape hatch.
 */
export async function resolveDriftEntry(formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { error: "missing id" }

  const sb = await createSupabaseServer()
  const { error } = await sb.rpc("resolve_drift_entry", {
    p_id: id,
    p_resolution: "manual_review",
    p_resolved_by: "admin",
  })
  if (error) return { error: error.message }

  revalidatePath("/admin/sync-issues")
  return { ok: "Resolved" }
}

/**
 * Bulk-clear drift entries whose underlying invoice has caught up to or
 * passed the flagged QBO timestamp. Safe to run any time — only resolves
 * rows that are demonstrably stale.
 */
export async function resolveStaleInvoiceDrift(): Promise<ActionState> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.rpc("resolve_stale_invoice_drift")
  if (error) return { error: error.message }

  revalidatePath("/admin/sync-issues")
  const n = typeof data === "number" ? data : 0
  return { ok: n === 0 ? "Nothing to clear." : `Cleared ${n} stale entr${n === 1 ? "y" : "ies"}.` }
}
