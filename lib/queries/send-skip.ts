import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

export interface WorkOrderSendSkip {
  note: string | null
  actor: string
  at: string
}

/**
 * The work order's own Skip sending, or null when sending is allowed: the
 * latest delivery_waived / delivery_waiver_revoked on aggregate work_order.
 * billing.send_waived(invoice) folds these with the invoice's own, so this is
 * what the invoice will inherit when it links. Admin client because
 * billing.events is not readable by anon (only one boolean + note leaves here).
 */
export async function getWorkOrderSendSkip(woNumber: string): Promise<WorkOrderSendSkip | null> {
  const { data } = await createSupabaseAdmin()
    .schema("billing")
    .from("events")
    .select("type, actor, occurred_at, payload")
    .eq("aggregate", "work_order")
    .eq("aggregate_id", woNumber)
    .in("type", ["delivery_waived", "delivery_waiver_revoked"])
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data || data.type !== "delivery_waived") return null
  return {
    note: (data.payload as { note?: string | null } | null)?.note ?? null,
    actor: data.actor,
    at: data.occurred_at,
  }
}
