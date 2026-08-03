import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { groupFindings, type FindingRow } from "../../_lib/findings"
import { FindingsWorkbench, type WorkbenchVisit } from "../../_components/findings-workbench"

/**
 * Full-page findings review for one customer-month. The queue (for
 * prev/next and auto-advance) is every OPEN customer this month in the same
 * flagged-$ order as the findings table.
 */
export default async function FindingReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { customerId: rawId } = await params
  const { month } = await searchParams
  const customerId = parseInt(rawId, 10)
  if (!customerId || !month || !/^\d{4}-\d{2}$/.test(month)) notFound()

  const sb = await createSupabaseServer()
  const visitsPromise = sb.rpc("maint_billing_review_visits", { p_customer_id: customerId, p_month: `${month}-01` })
  const { data, error } = await sb
    .schema("billing")
    .from("v_findings_review")
    .select("id, billing_month_id, month, customer_id, customer_name, phase, rule, severity, message, cents, detected_at, resolved_at, resolved_by, resolution, month_invoiced")
    .eq("phase", "audit")
    .eq("month", `${month}-01`)
    .limit(2000)
  if (error) {
    return <div className="p-7 text-sm text-coral">findings read failed: {String(error.message ?? error)}</div>
  }

  const groups = groupFindings((data ?? []) as FindingRow[])
  const mine = groups.find((g) => g.customerId === customerId)
  if (!mine) notFound()

  // Open customers in table order; a just-resolved customer keeps its slot
  // so prev/next still works from its own page.
  const queue = groups
    .filter((g) => g.openIds.length > 0 || g.customerId === customerId)
    .map((g) => ({ customerId: g.customerId, name: g.customerName }))

  const visitsRes = await visitsPromise
  return (
    <div className="px-7 pt-6 pb-10">
      <FindingsWorkbench group={mine} queue={queue} visits={(visitsRes.data ?? []) as WorkbenchVisit[]} />
    </div>
  )
}
