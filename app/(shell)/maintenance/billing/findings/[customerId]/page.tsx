import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { groupFindings, type FindingRow } from "../../_lib/findings"
import { FindingsWorkbench } from "../../_components/findings-workbench"
import type { ServiceLogVisit } from "../../../_components/service-log"
import type { FlagContext } from "../../_components/chem-history-context"

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
  const historyPromise = sb.rpc("maint_billing_customer_chem_history", { p_customer_id: customerId, p_through: `${month}-01` })
  const mediansPromise = sb.rpc("maint_billing_chem_medians", { p_month: `${month}-01` })
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

  const [visitsRes, historyRes, mediansRes] = await Promise.all([visitsPromise, historyPromise, mediansPromise])

  // The same why-flagged context bill-review shows. The peer group is the
  // AUDIT's (task provision overrides the demographic group) — parsed from
  // the finding's own sentence; the medians RPC supplies that group's
  // median when it tracks it (provision groups may have none).
  const peerGroup = mine.findings[0]?.message.match(/95th percentile of (\S+) /)?.[1] ?? null
  const median = (mediansRes.data ?? []).find((m: { peer_group: string }) => m.peer_group === peerGroup) as
    | { median_usd: number; n_customers: number }
    | undefined
  const flagContext: FlagContext = {
    peerGroup,
    peerMedian: median?.median_usd ?? null,
    peerN: median?.n_customers ?? null,
    history: (historyRes.data ?? []) as { month: string; chem_usd: number; visits: number }[],
  }

  return (
    <div className="px-7 pt-6 pb-10">
      <FindingsWorkbench
        group={mine}
        queue={queue}
        visits={(visitsRes.data ?? []) as ServiceLogVisit[]}
        flagContext={flagContext}
      />
    </div>
  )
}
