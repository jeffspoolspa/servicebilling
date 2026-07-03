import type { ReactNode } from "react"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * THE invoice rendering for the whole app — one QBO invoice's identity,
 * header fields, memo, and line items. Consumed by the work-order detail
 * (Invoice tab) and the maintenance billing-period detail; refine the
 * formatting here and every surface follows.
 *
 * Presentational + server-safe (no hooks): callers fetch the row from
 * billing.invoices however they like and pass it in. `afterHeader` is a slot
 * between the header fields and the line items for caller-specific blocks
 * (the WO page injects its classification editor there).
 */
export interface InvoiceCardData {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  txn_date: string | null
  due_date: string | null
  memo: string | null
  qbo_class: string | null
  subtotal: number | string | null
  total_amt: number | string | null
  balance: number | string | null
  email_status: string | null
  line_items: InvoiceCardLineItem[] | null
}

export interface InvoiceCardLineItem {
  qty: number | null
  amount: number | null
  item_name: string | null
  line_type: string | null
  unit_price: number | null
  description: string | null
}

export function InvoiceCard({
  invoice,
  afterHeader,
}: {
  invoice: InvoiceCardData
  afterHeader?: ReactNode
}) {
  const subtotal = Number(invoice.subtotal ?? 0)
  const total = Number(invoice.total_amt ?? 0)
  const balance = Number(invoice.balance ?? 0)
  const tax = Math.max(0, Number((total - subtotal).toFixed(2)))
  const items = invoice.line_items ?? []
  const descLine = items.find((li) => li.line_type === "description" && li.description)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice {invoice.doc_number ?? "—"}</CardTitle>
        <div className="ml-auto flex items-center gap-2">
          {invoice.email_status === "EmailSent" ? (
            <Pill tone="teal" dot>
              sent
            </Pill>
          ) : (
            <Pill tone="neutral" dot>
              not sent
            </Pill>
          )}
          {balance === 0 ? (
            <Pill tone="grass" dot>
              paid
            </Pill>
          ) : (
            <Pill tone="sun" dot>
              balance {formatCurrency(balance)}
            </Pill>
          )}
        </div>
      </CardHeader>

      <div className="px-5 py-3 grid grid-cols-4 gap-x-4 gap-y-3 text-[12px] border-b border-line-soft">
        <Field label="Customer" value={invoice.customer_name ?? "—"} />
        <Field label="Invoice date" value={formatDate(invoice.txn_date)} />
        <Field label="Due date" value={formatDate(invoice.due_date)} />
        <Field label="QBO class" value={invoice.qbo_class ?? "—"} />
        <Field label="Subtotal" value={formatCurrency(subtotal)} mono />
        {/* Tax derived from (total − subtotal) — always matches what the
            customer sees on the invoice. */}
        <Field label="Tax" value={formatCurrency(tax)} mono />
        <Field label="Total" value={formatCurrency(total)} mono />
        <Field
          label="Memo"
          value={invoice.memo ?? descLine?.description ?? "—"}
        />
      </div>

      {afterHeader}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
              <th className="px-5 py-2 font-medium">Item</th>
              <th className="font-medium">Description</th>
              <th className="font-medium num text-right">Qty</th>
              <th className="font-medium num text-right">Unit</th>
              <th className="font-medium num text-right pr-5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items
              .filter((li) => li.line_type !== "description")
              .map((li, idx) => {
                const isSubtotal = li.line_type === "subtotal"
                const isDiscount = li.line_type === "discount"
                return (
                  <tr
                    key={idx}
                    className={
                      "border-b border-line-soft " +
                      (isSubtotal ? "bg-white/[0.02] font-medium" : "")
                    }
                  >
                    <td className="px-5 py-2">
                      {isSubtotal ? (
                        <span className="text-ink-dim text-[11px] uppercase tracking-wider">
                          Subtotal
                        </span>
                      ) : isDiscount ? (
                        <span className="text-coral text-xs">Discount</span>
                      ) : (
                        <span className="text-ink text-xs">
                          {(li.item_name ?? "—").replace(/^NA\* - /, "")}
                        </span>
                      )}
                    </td>
                    <td className="text-ink-dim text-xs">{li.description || "—"}</td>
                    <td className="num text-right text-ink-mute text-xs">
                      {li.qty != null ? li.qty : ""}
                    </td>
                    <td className="num text-right text-ink-mute text-xs">
                      {li.unit_price != null ? formatCurrency(li.unit_price) : ""}
                    </td>
                    <td
                      className={
                        "num text-right pr-5 " +
                        (isSubtotal ? "text-ink" : "text-ink-dim") +
                        (isDiscount ? " text-coral" : "")
                      }
                    >
                      {formatCurrency(Number(li.amount ?? 0))}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
        {items.length === 0 && (
          <div className="px-5 py-6 text-center text-ink-mute text-sm">
            No line items returned from QBO.
          </div>
        )}
      </div>
    </Card>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">{label}</div>
      <div className={`${mono ? "num text-ink" : "text-ink"} mt-0.5 truncate`} title={value}>
        {value}
      </div>
    </div>
  )
}
