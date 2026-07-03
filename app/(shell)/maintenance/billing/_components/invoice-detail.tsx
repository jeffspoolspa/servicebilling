"use client"

import { useEffect, useState } from "react"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"

export interface InvoiceDetailData {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  txn_date: string | null
  due_date: string | null
  memo: string | null
  statement_memo: string | null
  qbo_class: string | null
  subtotal: number | null
  total_amt: number | null
  balance: number | null
  email_status: string | null
  line_items:
    | {
        qty: number | null
        amount: number | null
        item_name: string | null
        line_type: string | null
        unit_price: number | null
        description: string | null
      }[]
    | null
}

export function InvoiceDetail({ qboInvoiceId }: { qboInvoiceId: string }) {
  const [inv, setInv] = useState<InvoiceDetailData | "loading" | "error">("loading")

  useEffect(() => {
    let alive = true
    setInv("loading")
    fetch(`/api/maintenance-billing/invoice?qbo_invoice_id=${qboInvoiceId}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setInv(j.invoice as InvoiceDetailData))
      .catch(() => alive && setInv("error"))
    return () => {
      alive = false
    }
  }, [qboInvoiceId])

  if (inv === "loading")
    return <div className="text-[11px] text-ink-mute">Loading invoice…</div>
  if (inv === "error")
    return <div className="text-[11px] text-coral">Failed to load invoice detail.</div>

  const items = (inv.line_items ?? []).filter((li) => li.line_type === "item")
  const descLine = (inv.line_items ?? []).find(
    (li) => li.line_type === "description" && li.description,
  )
  const tax = (inv.total_amt ?? 0) - (inv.subtotal ?? 0)
  return (
    <div className="rounded-lg border border-line-soft overflow-hidden max-w-2xl">
      {/* full header (mirrors the work-order invoice block, kept simple) */}
      <div className="px-4 py-3 bg-white/[0.02] border-b border-line-soft space-y-2">
        <div className="flex items-center justify-between text-[12px]">
          <div className="text-ink">
            Invoice <span className="font-mono">#{inv.doc_number}</span>
            {inv.customer_name && (
              <span className="text-ink-mute ml-2">{inv.customer_name}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            {inv.email_status === "EmailSent" && <Pill tone="cyan">sent</Pill>}
            {(inv.balance ?? 0) <= 0 ? (
              <Pill tone="grass">paid</Pill>
            ) : (
              <span className="text-ink-mute">
                balance{" "}
                <span className="font-mono num text-sun">{formatCurrency(inv.balance ?? 0)}</span>
              </span>
            )}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 text-[11px]">
          <HeaderField label="Invoice date" value={inv.txn_date ?? "—"} mono />
          <HeaderField label="Due date" value={inv.due_date ?? "—"} mono />
          <HeaderField label="Class" value={inv.qbo_class ?? "—"} />
          <HeaderField label="Total" value={formatCurrency(inv.total_amt ?? 0)} mono />
        </div>
        <div className="text-[11px]">
          <span className="text-[10px] uppercase tracking-wide text-ink-mute mr-2">Memo</span>
          <span className="text-ink-dim">
            {inv.memo ?? descLine?.description ?? "—"}
          </span>
        </div>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft/60">
            <th className="px-4 py-1.5 font-medium">Item</th>
            <th className="px-4 py-1.5 font-medium text-right">Qty</th>
            <th className="px-4 py-1.5 font-medium text-right">Rate</th>
            <th className="px-4 py-1.5 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((li, i) => (
            <tr key={i} className="border-b border-line-soft/30 last:border-0 text-ink-dim">
              <td className="px-4 py-1.5" title={li.description ?? undefined}>
                {(li.item_name ?? li.description ?? "—").replace(/^NA\* - /, "")}
              </td>
              <td className="px-4 py-1.5 text-right font-mono num">{li.qty ?? ""}</td>
              <td className="px-4 py-1.5 text-right font-mono num">
                {li.unit_price != null ? formatCurrency(li.unit_price) : ""}
              </td>
              <td className="px-4 py-1.5 text-right font-mono num text-ink">
                {li.amount != null ? formatCurrency(li.amount) : ""}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-soft text-ink">
            <td className="px-4 py-1.5" colSpan={3}>
              Subtotal{tax > 0.005 && <span className="text-ink-mute"> · tax {formatCurrency(tax)}</span>}
            </td>
            <td className="px-4 py-1.5 text-right font-mono num font-semibold">
              {inv.subtotal != null ? formatCurrency(inv.subtotal) : "—"}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function HeaderField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-mute">{label}</div>
      <div className={mono ? "font-mono num text-ink-dim" : "text-ink-dim"}>{value}</div>
    </div>
  )
}
