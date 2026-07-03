import { notFound } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingPeriods,
  listPeriodAttempts,
  formatMonth,
} from "../../_lib/queries"
import { REASON_LABEL, STATUS_LABEL, STATUS_TONE } from "../../_lib/status"
import { PeriodTabs } from "../../_components/period-tabs"
import { BackButton } from "../../_components/back-button"

export const metadata = { title: "Maintenance · Billing period" }
export const dynamic = "force-dynamic"

/**
 * Billing-period detail (the maintenance counterpart of the work-order page):
 * one promise = one ION task-month = one QBO invoice. Tabs: the linked
 * invoice (line items), the billing month (visit calendar), and processing
 * attempts (the customer-month's autopay transactions). Opened from Ready to
 * Process; the back button returns to the exact filtered view.
 */
export default async function BillingPeriodPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { id } = await params
  const { month } = await searchParams
  if (!month || !/^\d{4}-\d{2}$/.test(month)) notFound()

  const periods = await listBillingPeriods(`${month}-01`)
  const p = periods.find((r) => r.id === id)
  if (!p) notFound()

  const attempts = p.qbo_customer_id
    ? await listPeriodAttempts(p.qbo_customer_id, month)
    : []
  const siblings = periods.filter(
    (r) => r.qbo_customer_id === p.qbo_customer_id && r.id !== p.id,
  )

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <BackButton fallbackHref={`/maintenance/billing/process?month=${month}`} />
            <h2 className="font-display text-[16px]">{p.customer_name ?? "Unknown customer"}</h2>
            <Pill tone={STATUS_TONE[p.processing_status]} dot>
              {STATUS_LABEL[p.processing_status]}
            </Pill>
            {p.needs_review_reason && (
              <Pill tone="coral">
                {REASON_LABEL[p.needs_review_reason] ?? p.needs_review_reason}
              </Pill>
            )}
            {p.on_autopay && (
              <span className="text-[10px] text-teal uppercase tracking-wide">autopay</span>
            )}
          </div>
          <div className="text-ink-mute text-[12px] mt-1">
            {formatMonth(`${month}-01`)} · {p.service_name ?? "task"}
            {p.frequency && ` · ${p.frequency.replace(/_/g, " ")}`}
            {p.office && ` · ${p.office}`}
            {siblings.length > 0 && ` · +${siblings.length} more task(s) this month`}
          </div>
        </div>
        <div className="flex gap-6 text-[12px]">
          <Stat label="Expected" value={cents(p.expected_total_cents)} strong />
          <Stat label="ION" value={cents(p.ion_amt_cents)} />
          <Stat label="QBO subtotal" value={p.qbo_total != null ? formatCurrency(Number(p.qbo_total)) : "—"} />
          <Stat
            label="Balance"
            value={p.qbo_balance != null ? formatCurrency(Number(p.qbo_balance)) : "—"}
            tone={
              p.qbo_balance != null && p.expected_total_cents != null &&
              Number(p.qbo_balance) * 100 < p.expected_total_cents
                ? "grass"
                : undefined
            }
          />
        </div>
      </div>

      <PeriodTabs
        qboInvoiceId={p.qbo_invoice_id}
        customerId={p.customer_id}
        month={month}
        attempts={attempts}
        creditsApplied={p.credits_applied}
      />
    </div>
  )
}

function cents(v: number | null): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

function Stat({
  label,
  value,
  strong,
  tone,
}: {
  label: string
  value: string
  strong?: boolean
  tone?: "grass"
}) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-ink-mute">{label}</div>
      <div
        className={`font-mono num ${tone === "grass" ? "text-grass" : strong ? "text-ink" : "text-ink-dim"}`}
      >
        {value}
      </div>
    </div>
  )
}
