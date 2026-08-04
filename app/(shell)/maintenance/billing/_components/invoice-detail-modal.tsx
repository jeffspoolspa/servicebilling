"use client"

import { Dialog } from "@/components/ui/dialog"
import { Pill } from "@/components/ui/pill"
import { HistoryTimeline, type HistoryRow } from "@/components/ui/history-timeline"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"

/**
 * The INVOICE detail — our cached copy of the document, formatted the way
 * the customer reads it (date breaks, item lines, totals), with the
 * payments applied against it and its machine history. Opens as a large
 * modal over whatever screen linked it; the mirror is the source (kept
 * warm by write echoes and the QBO webhook), so this is the published
 * read surface, never a live QBO call.
 */

export interface InvoiceLineItem {
  line_type?: "description" | "item" | "subtotal" | string
  item_name?: string | null
  description?: string | null
  qty?: number | null
  unit_price?: number | null
  amount?: number | null
}

export interface InvoiceDetail {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name?: string | null
  txn_date: string | null
  due_date?: string | null
  memo?: string | null
  statement_memo?: string | null
  qbo_class?: string | null
  subtotal: number | null
  total_amt: number | null
  balance: number | null
  email_status: string | null
  line_items: InvoiceLineItem[] | null
}

export interface AppliedPayment {
  qbo_payment_id: string
  txn_date: string | null
  applied_amount: number | null
  total_amt: number | null
  memo: string | null
  payment_method_name: string | null
}

export interface InvoiceEvent {
  seq: number
  occurred_at: string
  type: string
  actor: string | null
  payload: Record<string, unknown> | null
}

/** QBO's fully-qualified names read "NA* - Services:CHEMICAL TESTING" — show the leaf. */
const leafName = (name: string | null | undefined) => (name ?? "").split(":").pop() ?? ""

function invoiceHistoryRows(events: InvoiceEvent[]): HistoryRow[] {
  return events.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>
    const base = {
      key: `e${e.seq}`,
      at: e.occurred_at,
      seq: e.seq,
      tag: e.actor === "billing_pipeline" ? "pipeline" : e.actor ?? "system",
    }
    switch (e.type) {
      case "invoice_created":
        return { ...base, action: <>Created in QBO<span className="text-ink-dim"> · doc {String(p.doc_number ?? "")} · {formatCurrency(Number(p.subtotal_cents ?? 0) / 100)}</span></> }
      case "credits_matched": {
        const credits = Array.isArray(p.credits) ? (p.credits as { id: string; available_cents: number }[]) : []
        return { ...base, action: <>Open credits matched<span className="text-ink-dim"> · {credits.length} found</span></> }
      }
      case "credit_applied":
        return { ...base, action: <>Credit applied<span className="text-ink-dim"> · {String(p.kind ?? "payment")} #{String(p.credit_id ?? "")} · {formatCurrency(Number(p.applied_cents ?? 0) / 100)}</span></> }
      case "invoice_credits_checked":
        return { ...base, action: <>Credits checked<span className="text-ink-dim"> · {Number(p.credits_applied ?? 0)} applied</span></> }
      case "charge_captured":
        return { ...base, action: <>Card charged<span className="text-ink-dim"> · payment #{String(p.qbo_payment_id ?? "")} · {formatCurrency(Number(p.amount_cents ?? 0) / 100)}</span></> }
      case "charge_declined":
        return { ...base, action: "Charge declined — parked for a person", note: typeof p.reason === "string" ? p.reason : null }
      case "charge_uncertain":
        return { ...base, action: "Charge outcome unknown — parked for a person", note: typeof p.detail === "string" ? p.detail : null }
      case "invoice_emailed":
        return { ...base, action: "Emailed to the customer" }
      case "invoice_deleted":
        return { ...base, action: "Deleted — retracted before send", note: typeof p.reason === "string" ? p.reason : null }
      default:
        return { ...base, action: e.type.replace(/_/g, " ") }
    }
  })
}

export function InvoiceDetailModal({
  invoice,
  payments,
  history,
  onClose,
}: {
  invoice: InvoiceDetail | null
  payments: AppliedPayment[]
  history: InvoiceEvent[]
  onClose: () => void
}) {
  if (!invoice) return null
  const inv = invoice
  const paid = (inv.balance ?? 1) <= 0
  const taxCents = Math.round((Number(inv.total_amt ?? 0) - Number(inv.subtotal ?? 0)) * 100)

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className="text-[12.5px] text-ink mt-0.5">{children}</div>
    </div>
  )

  return (
    <Dialog open onClose={onClose} title={`Invoice ${inv.doc_number ?? inv.qbo_invoice_id}`} className="max-w-3xl">
      <div className="max-h-[78vh] overflow-y-auto -m-5 p-5 space-y-5">
        {/* the document header */}
        <div className="flex items-start justify-between gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 flex-1">
            <Field label="Customer">{inv.customer_name ?? "—"}</Field>
            <Field label="Invoice date">{inv.txn_date ?? "—"}</Field>
            <Field label="Due">{inv.due_date ?? "—"}</Field>
            <Field label="Class">{leafName(inv.qbo_class) || "—"}</Field>
          </div>
          <span className="flex items-center gap-1.5 flex-none">
            <Pill tone={inv.email_status === "EmailSent" ? "grass" : "neutral"}>
              {inv.email_status === "EmailSent" ? "sent" : "not sent"}
            </Pill>
            <Pill tone={paid ? "grass" : "sun"}>{paid ? "paid" : `balance ${formatCurrency(Number(inv.balance ?? 0))}`}</Pill>
          </span>
        </div>
        {inv.memo && <div className="text-[12px] text-ink-dim">{inv.memo}</div>}

        {/* the formatted document — our cache copy, as the customer reads it */}
        <div className="rounded border border-line-soft overflow-hidden">
          {(inv.line_items ?? [])
            .filter((l) => l.line_type !== "subtotal")
            .map((l, i) =>
              l.line_type === "description" ? (
                <div key={i} className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-white/[0.015]">
                  {l.description}
                </div>
              ) : (
                <div key={i} className="flex items-center gap-2.5 border-b border-line-soft/60 last:border-b-0 px-3 py-1.5">
                  <div className="flex-1 min-w-0">
                    <span className="text-[12px] text-ink">{leafName(l.item_name) || "—"}</span>
                    <span className="ml-2 font-mono text-[10px] text-ink-mute">
                      {l.qty != null ? `${l.qty} × ${l.unit_price != null ? formatCurrency(Number(l.unit_price)) : "—"}` : ""}
                    </span>
                    {l.description && <div className="text-[10.5px] text-ink-dim">{l.description}</div>}
                  </div>
                  <span className="font-mono num text-[12px] text-ink flex-none">
                    {l.amount != null ? formatCurrency(Number(l.amount)) : ""}
                  </span>
                </div>
              ),
            )}
          <div className="px-3 py-2 space-y-1 border-t border-line-soft bg-white/[0.01] text-[12px]">
            <div className="flex justify-between text-ink-dim">
              <span>Subtotal</span>
              <span className="font-mono num">{formatCurrency(Number(inv.subtotal ?? 0))}</span>
            </div>
            {taxCents > 0 && (
              <div className="flex justify-between text-ink-dim">
                <span>Tax</span>
                <span className="font-mono num">{formatCurrency(taxCents / 100)}</span>
              </div>
            )}
            <div className="flex justify-between text-ink font-medium">
              <span>Total</span>
              <span className="font-mono num">{formatCurrency(Number(inv.total_amt ?? 0))}</span>
            </div>
            <div className={cn("flex justify-between font-medium", paid ? "text-grass" : "text-sun")}>
              <span>Balance</span>
              <span className="font-mono num">{formatCurrency(Number(inv.balance ?? 0))}</span>
            </div>
          </div>
        </div>

        {/* payments applied — QBO's own linkage, from the payment mirror */}
        <div>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute mb-1.5">Payments applied</div>
          {payments.length === 0 ? (
            <div className="text-[12px] text-ink-mute">No payments applied.</div>
          ) : (
            <div className="rounded border border-line-soft overflow-hidden">
              {payments.map((p) => (
                <div key={p.qbo_payment_id} className="border-b border-line-soft/60 last:border-b-0 px-3 py-1.5">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[12px] text-ink">Payment #{p.qbo_payment_id}</span>
                    <span className="font-mono text-[10px] text-ink-mute">{p.txn_date ?? ""}</span>
                    {p.payment_method_name && <span className="text-[10.5px] text-ink-dim">{p.payment_method_name}</span>}
                    <span className="ml-auto font-mono num text-[12px] text-grass">
                      {formatCurrency(Number(p.applied_amount ?? 0))}
                    </span>
                  </div>
                  {p.memo && <div className="text-[10.5px] text-ink-dim mt-0.5 truncate">{p.memo}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <HistoryTimeline rows={invoiceHistoryRows(history)} title="History" emptyText="No events — this invoice predates the machine." />
      </div>
    </Dialog>
  )
}
