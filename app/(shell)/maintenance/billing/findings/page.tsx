import { createSupabaseServer } from "@/lib/supabase/server"
import { FindingsTable, type FindingRow } from "../_components/findings-table"

/**
 * The audit's review queue: billing.findings via the v_findings_review read
 * model. Open findings hold their month at the gate (findings_resolved);
 * marking one reviewed re-enqueues the month so the next advance re-gates it.
 */
export default async function FindingsPage() {
  const sb = await createSupabaseServer()
  const { data, error } = await sb
    .schema("billing")
    .from("v_findings_review")
    .select("id, billing_month_id, month, customer_id, customer_name, phase, rule, severity, message, cents, detected_at, resolved_at, resolved_by, resolution, month_invoiced")
    .order("detected_at", { ascending: false })
    .limit(2000)
  if (error) {
    return <div className="p-7 text-sm text-coral">findings read failed: {String(error.message ?? error)}</div>
  }
  return (
    <div className="p-7">
      <FindingsTable rows={(data ?? []) as FindingRow[]} />
    </div>
  )
}
