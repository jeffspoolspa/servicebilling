import { notFound } from "next/navigation"
import Link from "next/link"
import { createSupabaseServer } from "@/lib/supabase/server"
import { CustomerCard } from "@/components/work-orders/detail/customer-card"
import { getCustomerCard } from "@/lib/queries/dashboard"
import type { ServiceLogVisit } from "../../../_components/service-log"
import { MONTHS_SELECT, type MonthOverviewRow } from "../../_lib/months"
import { MonthWorkbench, type HistoryEvent, type InvoiceDetail } from "../../_components/month-workbench"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingMonthRepository } from "@/lib/billing/infrastructure/supabase-billing-month-repository"
import { resolveLaborSku } from "@/lib/billing/application/labor-resolution"
import { MonthNav } from "../../_components/month-nav"
import { displayStatus, MONTH_DISPLAY_STATUSES, type MonthDisplayStatus } from "../../_lib/months"

/**
 * One billing month's detail: the workbench with the month tab (history +
 * service log) and one tab per issued invoice with its sent/paid status.
 * All reads through the published surface: v_months_overview,
 * billing_month_history (aggregate OR participant), the review-visits RPC,
 * and the invoice-detail RPC per issued document.
 */
export default async function MonthDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ monthId: string }>
  searchParams: Promise<{ nav?: string }>
}) {
  const { monthId } = await params
  const { nav } = await searchParams
  const sb = await createSupabaseServer()

  const { data, error } = await sb.schema("billing").from("v_months_overview").select(MONTHS_SELECT).eq("id", monthId).limit(1)
  if (error) return <div className="p-7 text-sm text-coral">month read failed: {String(error.message ?? error)}</div>
  const m = (data ?? [])[0] as MonthOverviewRow | undefined
  if (!m) notFound()

  const monthDate = `${m.month.slice(0, 7)}-01`
  const issued = m.issued_invoices ?? []
  const { data: custRow } = await sb.from("Customers").select("qbo_customer_id").eq("id", m.customer_id).limit(1)
  const qboCustomerId = ((custRow ?? [])[0] as { qbo_customer_id: string | null } | undefined)?.qbo_customer_id ?? null
  const customerCard = await getCustomerCard(qboCustomerId)
  const [visitsRes, historyRes, itemsRes, tasksRes, findingsRes, noteRes, chemItemRes, fcRes, followUpsRes, ...perInvoice] = await Promise.all([
    sb.rpc("maint_billing_review_visits", { p_customer_id: m.customer_id, p_month: monthDate }),
    sb.rpc("billing_month_history", { p_month_id: m.id }),
    sb.rpc("maint_billing_month_items", { p_month_id: m.id }),
    sb.rpc("maint_billing_month_tasks", { p_customer_id: m.customer_id, p_month: monthDate }),
    sb.schema("billing").from("v_findings_review").select("id, rule, severity, message, cents, detected_at, resolved_at, resolved_by, resolution").eq("billing_month_id", m.id).limit(200),
    sb.schema("billing").from("billing_months").select("summary_note, explainer_generated_at, explainer_attach_requested_at, explainer_notes").eq("id", m.id).limit(1),
    sb.rpc("maint_billing_month_chem_item_summary", { p_customer_id: m.customer_id, p_month: monthDate }),
    sb.rpc("maint_billing_fc_history", { p_customer_id: m.customer_id }),
    sb.from("follow_ups").select("id, created_at, issue, description, status, next_steps, equipment_off, source_tech_name")
      .eq("customer_id", m.customer_id)
      .gte("created_at", monthDate)
      .lt("created_at", new Date(Date.UTC(+monthDate.slice(0, 4), +monthDate.slice(5, 7), 1)).toISOString().slice(0, 10))
      .order("created_at", { ascending: false })
      .limit(50),
    ...issued.flatMap((inv) => [
      sb.rpc("maint_billing_invoice_detail", { p_qbo_invoice_id: inv.qbo_invoice_id }),
      sb.rpc("maint_billing_invoice_payments", { p_qbo_invoice_id: inv.qbo_invoice_id }),
      sb.rpc("maint_billing_invoice_history", { p_qbo_invoice_id: inv.qbo_invoice_id }),
      sb.rpc("maint_billing_invoice_method", { p_qbo_invoice_id: inv.qbo_invoice_id }),
    ]),
  ])

  const invoices: InvoiceDetail[] = []
  const invoicePayments: Record<string, unknown[]> = {}
  const invoiceHistory: Record<string, unknown[]> = {}
  const invoiceMethods: Record<string, unknown> = {}
  // Blank labor names resolve against the CONFIRMED QBO catalog — the same
  // exact -> category -> rate ladder the issue refuses on, so a name shown
  // here is a name that will map.
  let ledgerItems = (itemsRes.data ?? []) as { kind: string; item_name: string | null; task_id: string | null; unit_price_cents: number; service_date: string | null }[]
  if (ledgerItems.some((i) => i.kind === "labor" && !i.item_name)) {
    const repo = new SupabaseBillingMonthRepository(createSupabaseAdmin() as never)
    const taskIds = [...new Set(ledgerItems.map((i) => i.task_id).filter((x): x is string => !!x))]
    const [laborCatalog, metaMap] = await Promise.all([repo.laborItems(), repo.taskDocMeta(taskIds)])
    const categories = new Map([...metaMap.entries()].map(([id, t]) => [id, t.category]))
    ledgerItems = ledgerItems.map((i) => {
      if (i.kind !== "labor" || i.item_name) return i
      const r = resolveLaborSku({ itemName: "", taskId: i.task_id, unitPriceCents: i.unit_price_cents, serviceDate: i.service_date }, categories, laborCatalog)
      return r ? { ...i, item_name: r.name } : i
    })
  }
  const monthTasks = (tasksRes.data ?? []) as never[]
  const findings = (findingsRes.data ?? []) as never[]
  const noteRow = ((noteRes.data ?? [])[0] as { summary_note?: string | null; explainer_generated_at?: string | null; explainer_attach_requested_at?: string | null; explainer_notes?: unknown[] } | undefined)
  const summaryNote = noteRow?.summary_note ?? null
  const followUps = (followUpsRes.data ?? []) as never[]
  const chemItemSummary = (chemItemRes.data ?? []) as never[]
  const fcHistory = (fcRes.data ?? []) as never[]
  issued.forEach((inv, i) => {
    const detail = ((perInvoice[i * 4].data ?? []) as InvoiceDetail[])[0]
    if (detail) invoices.push(detail)
    invoicePayments[inv.qbo_invoice_id] = perInvoice[i * 4 + 1].data ?? []
    invoiceHistory[inv.qbo_invoice_id] = perInvoice[i * 4 + 2].data ?? []
    invoiceMethods[inv.qbo_invoice_id] = ((perInvoice[i * 4 + 3].data ?? []) as unknown[])[0] ?? null
  })

  // PREV/NEXT walk the SAME filtered, sorted list the table showed (the
  // `nav` param carries the status filter) — flag to flag when it's held.
  const navStatus = nav && (MONTH_DISPLAY_STATUSES as string[]).includes(nav) ? (nav as MonthDisplayStatus) : null
  let monthNav: { prevHref: string | null; nextHref: string | null; label: string } | null = null
  if (nav) {
    const { data: siblings } = await sb
      .schema("billing")
      .from("v_months_overview")
      .select(MONTHS_SELECT)
      .eq("month", m.month)
      .limit(3000)
    const ordered = ((siblings ?? []) as MonthOverviewRow[])
      .filter((r) => (navStatus ? displayStatus(r) === navStatus : true))
      .sort((a, b) => b.subtotal_cents - a.subtotal_cents)
    const idx = ordered.findIndex((r) => r.id === m.id)
    const q = `?nav=${nav}`
    if (idx >= 0) {
      monthNav = {
        prevHref: idx > 0 ? `/maintenance/billing/months/${ordered[idx - 1].id}${q}` : null,
        nextHref: idx < ordered.length - 1 ? `/maintenance/billing/months/${ordered[idx + 1].id}${q}` : null,
        label: `${idx + 1} of ${ordered.length}${navStatus ? ` ${navStatus}` : ""}`,
      }
    } else if (ordered.length > 0) {
      // The month LEFT the filtered list (just issued a held one, say) —
      // keep walking: neighbors come from its sort position.
      const at = ordered.findIndex((r) => r.subtotal_cents < m.subtotal_cents)
      const nextIdx = at === -1 ? null : at
      const prevIdx = at === -1 ? ordered.length - 1 : at - 1 >= 0 ? at - 1 : null
      monthNav = {
        prevHref: prevIdx !== null ? `/maintenance/billing/months/${ordered[prevIdx].id}${q}` : null,
        nextHref: nextIdx !== null ? `/maintenance/billing/months/${ordered[nextIdx].id}${q}` : null,
        label: `${ordered.length} ${navStatus ?? ""} left`.trim(),
      }
    }
  }

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-center justify-end gap-4">
        {monthNav && <MonthNav prevHref={monthNav.prevHref} nextHref={monthNav.nextHref} label={monthNav.label} />}
        <Link href={`/maintenance/billing?month=${m.month.slice(0, 7)}` as never} className="text-[12px] text-ink-mute hover:text-ink underline underline-offset-2">
          Back to months
        </Link>
      </div>
      {customerCard && <CustomerCard data={customerCard} />}
      <MonthWorkbench
        m={m}
        visits={(visitsRes.data ?? []) as ServiceLogVisit[]}
        history={(historyRes.data ?? []) as HistoryEvent[]}
        invoices={invoices}
        invoicePayments={invoicePayments as never}
        invoiceHistory={invoiceHistory as never}
        invoiceMethods={invoiceMethods as never}
        ledgerItems={ledgerItems as never}
        monthTasks={monthTasks as never}
        findings={findings as never}
        summaryNote={summaryNote}
        chemItemSummary={chemItemSummary as never}
        followUps={followUps as never}
        explainer={{
          generatedAt: noteRow?.explainer_generated_at ?? null,
          attachRequestedAt: noteRow?.explainer_attach_requested_at ?? null,
          url: `/api/billing/months/${m.id}/explainer-view`,
          notes: (noteRow?.explainer_notes ?? []) as never,
        }}
        fcHistory={fcHistory as never}
      />
    </div>
  )
}
