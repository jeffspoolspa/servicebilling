import { Card } from "@/components/ui/card"
import {
  listAutopayCustomers,
  listBillingMonths,
  listBillingPeriods,
  listInFlightPeriodIds,
  formatMonth,
  type BillingPeriodRow,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"
import { MonthSummary } from "../_components/month-summary"
import { ProcessTable, type ProcessCustomer } from "../_components/process-table"

export const metadata = { title: "Maintenance · Billing · Process" }
export const dynamic = "force-dynamic"

/**
 * Ready-to-process stage: linked, preprocessed periods whose gates passed —
 * one row per customer (autopay sweeps the customer), cross-referenced
 * against the autopay roster so you can see the card each charge will hit.
 * Selection + actions + all table interactions live client-side in
 * ProcessTable; processing runs f/billing/process_maint_period
 * (fire-and-forget, tracked by the Processing chip).
 */
export default async function ProcessPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const sp = await searchParams
  let months
  try {
    months = await listBillingMonths()
  } catch (e) {
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          Billing data unavailable.
          <div className="mt-2 text-[11px]">{e instanceof Error ? e.message : String(e)}</div>
        </Card>
      </div>
    )
  }
  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ??
    monthOptions[0]?.value ??
    new Date().toISOString().slice(0, 7)
  const monthDate = `${selected}-01`

  const [periods, roster, inFlight] = await Promise.all([
    listBillingPeriods(monthDate),
    listAutopayCustomers(),
    listInFlightPeriodIds(),
  ])
  const cardByCustomer = new Map(roster.map((r) => [r.qbo_customer_id, r]))

  // a running batch's periods leave Ready immediately (the queue sheet
  // tracks them) even though their stored status hasn't flipped yet
  const ready = periods.filter(
    (p) => p.processing_status === "ready_to_process" && !inFlight.has(p.id),
  )
  const held = periods.filter((p) => p.processing_status === "needs_review")
  const pending = periods.filter((p) =>
    ["pending", "ion_matched"].includes(p.processing_status),
  )

  // One row per customer: autopay charges sweep the customer, the invoice
  // email goes per invoice — group the customer's ready periods together.
  const byCustomer = new Map<string, BillingPeriodRow[]>()
  for (const r of ready) {
    const key = r.qbo_customer_id ?? `?${r.customer_name}`
    const arr = byCustomer.get(key) ?? []
    arr.push(r)
    byCustomer.set(key, arr)
  }
  const customers: ProcessCustomer[] = [...byCustomer.entries()].map(([qboId, list]) => {
    const card = list[0].qbo_customer_id
      ? cardByCustomer.get(list[0].qbo_customer_id)
      : undefined
    return {
      qbo_customer_id: qboId,
      customer_name: list[0].customer_name ?? qboId,
      total_cents: list.reduce((s, r) => s + (r.expected_total_cents ?? 0), 0),
      balance_cents: Math.round(list.reduce((s, r) => s + (r.qbo_balance ?? 0), 0) * 100),
      invoice_list: list.map((r) => ({
        period_id: r.id,
        doc_number: r.qbo_doc_number,
      })),
      task_count: list.length,
      sent: list.every((r) => r.invoice_sent === true),
      on_autopay: list[0].on_autopay,
      card: card
        ? {
            method: card.payment_method,
            card_type: card.card_type,
            last_four: card.last_four,
            payment_status: card.payment_status,
          }
        : null,
      segment: list[0].segment ?? "",
      office: (list[0].office ?? "").replace(", GA", ""),
      frequency: list[0].frequency ?? "",
    }
  })

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Ready to process</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {customers.length} customers ready · {held.length} held for review ·{" "}
              {pending.length} awaiting QBO sync
            </div>
          </div>
          <MonthSelect months={monthOptions} value={selected} />
        </div>
      </div>

      <MonthSummary all={periods} />

      <ProcessTable
        customers={customers}
        month={selected}
        monthLabel={formatMonth(monthDate)}
      />
    </div>
  )
}
