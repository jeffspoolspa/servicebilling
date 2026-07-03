import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import type { BillingPeriodRow } from "../_lib/queries"

/**
 * Month summary for the billing pages: one bucket of counts/amounts per
 * distinct linked QBO invoice, pivoted office × customer type (only combos
 * that exist appear), with an "All invoices" total row on top.
 * Server-safe, presentational — pages pass the month's unfiltered rows.
 */
interface SummaryBucket {
  label: string
  count: number
  amt: number
  sent: number
  sentAmt: number
  paid: number
  paidAmt: number
}

function summarizeInvoices(all: BillingPeriodRow[]): SummaryBucket[] {
  const seen = new Map<
    string,
    { total: number; sent: boolean; paid: boolean; office: string; segment: string }
  >()
  for (const r of all) {
    if (!r.qbo_invoice_id || seen.has(r.qbo_invoice_id)) continue
    seen.set(r.qbo_invoice_id, {
      total: r.qbo_total ?? 0,
      sent: r.invoice_sent === true,
      paid: r.qbo_balance != null && r.qbo_balance <= 0,
      office: (r.office ?? "unknown").replace(", GA", ""),
      segment: r.segment ?? "unknown",
    })
  }
  const buckets = new Map<string, SummaryBucket>()
  const add = (label: string, inv: { total: number; sent: boolean; paid: boolean }) => {
    const b = buckets.get(label) ?? {
      label,
      count: 0,
      amt: 0,
      sent: 0,
      sentAmt: 0,
      paid: 0,
      paidAmt: 0,
    }
    b.count += 1
    b.amt += inv.total
    if (inv.sent) {
      b.sent += 1
      b.sentAmt += inv.total
    }
    if (inv.paid) {
      b.paid += 1
      b.paidAmt += inv.total
    }
    buckets.set(label, b)
  }
  // pivot: one row per office × segment combo, under the total row
  for (const inv of seen.values()) {
    add("All invoices", inv)
    add(`${inv.office} · ${inv.segment}`, inv)
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.label === "All invoices") return -1
    if (b.label === "All invoices") return 1
    return a.label.localeCompare(b.label)
  })
}

export function MonthSummary({ all }: { all: BillingPeriodRow[] }) {
  const rows = summarizeInvoices(all)
  if (rows.length === 0) return null
  const money = (v: number) => formatCurrency(v)
  return (
    <Card className="px-4 py-3 overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-ink-mute text-[11px] uppercase tracking-wide">
            <th className="text-left font-medium pb-1.5"></th>
            <th className="text-right font-medium pb-1.5">Invoices</th>
            <th className="text-right font-medium pb-1.5">Amount</th>
            <th className="text-right font-medium pb-1.5">Sent</th>
            <th className="text-right font-medium pb-1.5">Sent $</th>
            <th className="text-right font-medium pb-1.5">Paid</th>
            <th className="text-right font-medium pb-1.5">Paid $</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const isTotal = b.label === "All invoices"
            return (
              <tr
                key={b.label}
                className={
                  isTotal ? "font-medium border-b border-line" : "text-ink-mute [&>td]:pt-1"
                }
              >
                <td className="text-left capitalize pr-4 whitespace-nowrap">{b.label}</td>
                <td className="text-right tabular-nums">{b.count.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(b.amt)}</td>
                <td className="text-right tabular-nums">{b.sent.toLocaleString()}</td>
                <td className="text-right tabular-nums">{money(b.sentAmt)}</td>
                <td className="text-right tabular-nums">{b.paid.toLocaleString()}</td>
                <td className="text-right tabular-nums text-teal">{money(b.paidAmt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
