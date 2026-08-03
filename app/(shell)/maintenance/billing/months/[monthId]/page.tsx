import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import type { ServiceLogVisit } from "../../../_components/service-log"
import { MONTHS_SELECT, type MonthOverviewRow } from "../../_lib/months"
import { MonthWorkbench, type HistoryEvent, type InvoiceDetail } from "../../_components/month-workbench"

/**
 * One billing month's detail: the workbench with the month tab (history +
 * service log) and one tab per issued invoice with its sent/paid status.
 * All reads through the published surface: v_months_overview,
 * billing_month_history (aggregate OR participant), the review-visits RPC,
 * and the invoice-detail RPC per issued document.
 */
export default async function MonthDetailPage({ params }: { params: Promise<{ monthId: string }> }) {
  const { monthId } = await params
  const sb = await createSupabaseServer()

  const { data, error } = await sb.schema("billing").from("v_months_overview").select(MONTHS_SELECT).eq("id", monthId).limit(1)
  if (error) return <div className="p-7 text-sm text-coral">month read failed: {String(error.message ?? error)}</div>
  const m = (data ?? [])[0] as MonthOverviewRow | undefined
  if (!m) notFound()

  const monthDate = `${m.month.slice(0, 7)}-01`
  const [visitsRes, historyRes, ...invoiceRes] = await Promise.all([
    sb.rpc("maint_billing_review_visits", { p_customer_id: m.customer_id, p_month: monthDate }),
    sb.rpc("billing_month_history", { p_month_id: m.id }),
    ...(m.issued_invoices ?? []).map((inv) => sb.rpc("maint_billing_invoice_detail", { p_qbo_invoice_id: inv.qbo_invoice_id })),
  ])

  const invoices = invoiceRes
    .map((r) => ((r.data ?? []) as InvoiceDetail[])[0])
    .filter((x): x is InvoiceDetail => Boolean(x))

  return (
    <div className="px-7 pt-6 pb-10">
      <MonthWorkbench
        m={m}
        visits={(visitsRes.data ?? []) as ServiceLogVisit[]}
        history={(historyRes.data ?? []) as HistoryEvent[]}
        invoices={invoices}
      />
    </div>
  )
}
