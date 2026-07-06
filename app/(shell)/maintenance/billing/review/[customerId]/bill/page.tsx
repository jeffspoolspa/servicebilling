import Link from "next/link"
import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { listBillingPeriods, listFlagItems, formatMonth } from "../../../_lib/queries"
import {
  ReviewWorkbench,
  type WorkbenchInvoice,
  type WorkbenchVisit,
  type UsualItem,
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
  const [periods, usual, visitsRes] = await Promise.all([
    listBillingPeriods(monthDate),
    listFlagItems(customerId, monthDate).catch(() => [] as UsualItem[]),
    supabase.rpc("maint_billing_review_visits", {
      p_customer_id: customerId,
      p_month: monthDate,
    }),
  ])
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
        customerName={name}
        month={month}
        monthLabel={formatMonth(monthDate)}
        reasons={reasons}
        notes={notes}
        periodIds={(held.length > 0 ? held : mine).map((p) => p.id)}
        invoices={invoices}
        visits={(visitsRes.data ?? []) as WorkbenchVisit[]}
        usual={usual as UsualItem[]}
      />
    </div>
  )
}
