import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listAutopayCustomers,
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
  type BillingPeriodRow,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"
import { ProcessActions } from "../_components/process-actions"

export const metadata = { title: "Maintenance · Billing · Process" }
export const dynamic = "force-dynamic"

/**
 * Ready-to-process stage: synced invoices with no unreviewed HIGH flag, one row
 * per customer (autopay sweeps per customer), cross-referenced against the
 * autopay roster so you can see the card each charge will hit. Select and
 * process -> the existing charging engine runs the card, sends the receipt
 * (autopay) and the invoice copy.
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
          Billing data unavailable — apply migration
          20260702130000_maintenance_billing_module_rpcs.sql.
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

  const [periods, roster] = await Promise.all([
    listBillingPeriods(monthDate),
    listAutopayCustomers(),
  ])
  const cardByCustomer = new Map(roster.map((r) => [r.qbo_customer_id, r]))

  // One row per customer: autopay charges sweep the customer, and the invoice
  // email goes per invoice — group the customer's ready periods together.
  const ready = periods.filter((p) => p.processing_status === "ready_to_process")
  const held = periods.filter((p) => p.processing_status === "needs_review")
  const pending = periods.filter((p) =>
    ["pending", "ion_matched", "queued"].includes(p.processing_status),
  )

  const byCustomer = new Map<string, BillingPeriodRow[]>()
  for (const r of ready) {
    const key = r.qbo_customer_id ?? `?${r.customer_name}`
    const arr = byCustomer.get(key) ?? []
    arr.push(r)
    byCustomer.set(key, arr)
  }
  const customerRows = [...byCustomer.entries()]
    .map(([qboId, list]) => {
      const card = list[0].qbo_customer_id
        ? cardByCustomer.get(list[0].qbo_customer_id)
        : undefined
      return {
        qbo_customer_id: qboId,
        customer_name: list[0].customer_name ?? qboId,
        total_cents: list.reduce((s, r) => s + (r.expected_total_cents ?? 0), 0),
        balance: list.reduce((s, r) => s + (r.qbo_balance ?? 0), 0),
        invoices: list
          .map((r) => r.qbo_doc_number)
          .filter(Boolean)
          .join(", "),
        task_count: list.length,
        on_autopay: list[0].on_autopay,
        card,
      }
    })
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name))

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Ready to process</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {customerRows.length} customers ready · {held.length} held for review ·{" "}
              {pending.length} awaiting QBO sync
            </div>
          </div>
          <MonthSelect months={monthOptions} value={selected} />
        </div>
      </div>

      {held.length > 0 && (
        <Card className="px-4 py-3 border-coral/30 bg-coral/5 flex items-center justify-between">
          <div className="text-[13px] text-coral">
            {held.length} invoice{held.length === 1 ? "" : "s"} held for review — excluded
            from processing until reviewed.
          </div>
          <Link
            href={`/maintenance/billing/review?month=${selected}` as never}
            className="text-[12px] text-coral underline underline-offset-2 shrink-0"
          >
            Review
          </Link>
        </Card>
      )}

      <ProcessActions
        month={selected}
        monthLabel={formatMonth(monthDate)}
        customers={customerRows.map((c) => ({
          qbo_customer_id: c.qbo_customer_id,
          customer_name: c.customer_name,
          total_cents: c.total_cents,
          on_autopay: c.on_autopay,
          card: c.card
            ? {
                method: c.card.payment_method,
                card_type: c.card.card_type,
                last_four: c.card.last_four,
                payment_status: c.card.payment_status,
              }
            : null,
          invoices: c.invoices,
          task_count: c.task_count,
        }))}
      />

      {customerRows.length === 0 && (
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          Nothing ready to process for {formatMonth(monthDate)}
          {pending.length > 0 &&
            ` — ${pending.length} bills are still awaiting the QBO invoice sync`}
          .
        </Card>
      )}
    </div>
  )
}
