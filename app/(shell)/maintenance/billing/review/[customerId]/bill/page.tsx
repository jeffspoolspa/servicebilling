import Link from "next/link"
import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { getCustomerMonth, listBillingPeriods, listFlagItems, formatMonth } from "../../../_lib/queries"
import {
  ReviewWorkbench,
  type WorkbenchInvoice,
  type WorkbenchVisit,
  type UsualItem,
  type BillAnalysis,
} from "../../../_components/review-workbench"

export const metadata = { title: "Maintenance · Bill review" }
export const dynamic = "force-dynamic"

/**
 * Bill-review workbench (design 2a): the customer-month's linked invoice
 * ledger against its service-log evidence — visits, readings, chems sold,
 * notes, and tech-uploaded photos. Reached from the Needs Review table.
 */
export default async function BillReviewPage({
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
  const monthDate = `${month}-01`

  const supabase = await createSupabaseServer()
  const [periods, usual, visitsRes, analysisRes, historyRes, mediansRes, cm] = await Promise.all([
    listBillingPeriods(monthDate),
    listFlagItems(customerId, monthDate).catch(() => [] as UsualItem[]),
    supabase.rpc("maint_billing_review_visits", {
      p_customer_id: customerId,
      p_month: monthDate,
    }),
    supabase.rpc("maint_billing_bill_analysis", {
      p_customer_id: customerId,
      p_month: monthDate,
    }),
    supabase.rpc("maint_billing_customer_chem_history", {
      p_customer_id: customerId,
      p_through: monthDate,
    }),
    supabase.rpc("maint_billing_chem_medians", { p_month: monthDate }),
    getCustomerMonth(customerId, monthDate).catch(() => null),
  ])
  const watchlistRes = await supabase.rpc("maint_watchlist_for_customer", {
    p_customer_id: customerId,
  })
  const reasonsRes = await supabase.rpc("maint_watchlist_reasons")
  const mine = periods.filter((p) => p.customer_id === customerId)
  if (mine.length === 0) notFound()
  if (visitsRes.error) throw new Error(visitsRes.error.message)

  const invoiceIds = [...new Set(mine.map((p) => p.qbo_invoice_id).filter(Boolean))] as string[]
  const invoices: WorkbenchInvoice[] = (
    await Promise.all(
      invoiceIds.map(async (id) => {
        const { data } = await supabase.rpc("maint_billing_invoice_detail", {
          p_qbo_invoice_id: id,
        })
        return (data ?? [])[0] as WorkbenchInvoice | undefined
      }),
    )
  ).filter(Boolean) as WorkbenchInvoice[]

  const name = mine[0].customer_name ?? `Customer #${customerId}`
  const reasons = [...new Set(mine.map((p) => p.needs_review_reason).filter(Boolean))] as string[]
  const notes = [...new Set(mine.map((p) => p.reconcile_notes).filter(Boolean))] as string[]
  const held = mine.filter((p) => p.processing_status === "needs_review")

  // the review queue: every held customer this month, same name-sorted order
  // as the Needs Review table, so prev/next walks the list the reviewer sees
  const queueMap = new Map<number, string>()
  for (const p of periods) {
    if (p.processing_status !== "needs_review" || p.customer_id == null) continue
    if (!queueMap.has(p.customer_id))
      queueMap.set(p.customer_id, p.customer_name ?? `#${p.customer_id}`)
  }
  const queue = [...queueMap.entries()]
    .map(([id, nm]) => ({ customerId: id, name: nm }))
    .sort((a, b) => a.name.localeCompare(b.name))
  // a just-released customer is no longer held but should still resolve its
  // position (so "approve -> next" works from a stale tab too)
  if (!queue.some((q) => q.customerId === customerId))
    queue.push({ customerId, name })
  queue.sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Bill review · {formatMonth(monthDate)}
          </div>
          <h2 className="font-display text-[18px] mt-0.5">{name}</h2>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <Link
            href={`/maintenance/billing/review/${customerId}?month=${month}` as never}
            className="text-ink-mute hover:text-ink underline underline-offset-2"
          >
            Flag drill-down
          </Link>
          <Link
            href={`/maintenance/billing/review?month=${month}` as never}
            className="text-ink-mute hover:text-ink underline underline-offset-2"
          >
            Back to review
          </Link>
        </div>
      </div>

      <ReviewWorkbench
        customerId={customerId}
        qboCustomerId={mine[0].qbo_customer_id ?? ""}
        customerName={name}
        month={month}
        monthLabel={formatMonth(monthDate)}
        reasons={reasons}
        notes={notes}
        periodIds={(held.length > 0 ? held : mine).map((p) => p.id)}
        invoices={invoices}
        visits={(visitsRes.data ?? []) as WorkbenchVisit[]}
        usual={usual as UsualItem[]}
        initialAnalysis={((analysisRes.data ?? [])[0] ?? null) as BillAnalysis | null}
        queue={queue}
        watchlist={(watchlistRes.data ?? []) as never}
        watchReasons={(reasonsRes.data ?? []) as never}
        flagContext={{
          peerGroup: cm?.peer_group ?? null,
          peerMedian:
            (mediansRes.data ?? []).find(
              (m: { peer_group: string }) => m.peer_group === cm?.peer_group,
            )?.median_usd ?? null,
          peerN:
            (mediansRes.data ?? []).find(
              (m: { peer_group: string }) => m.peer_group === cm?.peer_group,
            )?.n_customers ?? null,
          history: (historyRes.data ?? []) as { month: string; chem_usd: number; visits: number }[],
        }}
      />
    </div>
  )
}
