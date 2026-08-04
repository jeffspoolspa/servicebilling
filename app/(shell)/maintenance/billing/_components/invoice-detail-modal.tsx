"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Dialog } from "@/components/ui/dialog"
import { Pill } from "@/components/ui/pill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
  return <InvoiceDetailBody inv={invoice} payments={payments} history={history} onClose={onClose} />
}

function InvoiceDetailBody({
  inv,
  payments,
  history,
  onClose,
}: {
  inv: InvoiceDetail
  payments: AppliedPayment[]
  history: InvoiceEvent[]
  onClose: () => void
}) {
  const paid = (inv.balance ?? 1) <= 0
  const taxCents = Math.round((Number(inv.total_amt ?? 0) - Number(inv.subtotal ?? 0)) * 100)
  const lines = (inv.line_items ?? []).filter((l) => l.line_type !== "subtotal")
  // Long itemized documents fold closed; short ones open. The totals
  // ladder below always shows.
  const [linesOpen, setLinesOpen] = useState(lines.length <= 12)

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className="text-[12.5px] text-ink mt-0.5">{children}</div>
    </div>
  )

  return (
    <Dialog open onClose={onClose} title={`Invoice ${inv.doc_number ?? inv.qbo_invoice_id}`} className="max-w-3xl bg-bg-elev">
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
        <div className="rounded-lg border border-line overflow-hidden shadow-card">
          <button
            onClick={() => setLinesOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-left border-b border-line-soft"
          >
            {linesOpen ? <ChevronDown className="w-3.5 h-3.5 text-ink-mute" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-mute" />}
            <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">
              Lines · {lines.filter((l) => l.line_type !== "description").length}
            </span>
          </button>
          {linesOpen && (
            <Table className="text-[11.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Product</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) =>
                  l.line_type === "description" ? (
                    <TableRow key={i} className="hover:bg-transparent">
                      <TableCell colSpan={5} className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute py-1.5">
                        {l.description}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={i} className="text-ink-dim">
                      <TableCell className="text-ink whitespace-nowrap">{leafName(l.item_name) || "—"}</TableCell>
                      <TableCell className="text-ink-mute whitespace-normal">{l.description ?? ""}</TableCell>
                      <TableCell className="text-right font-mono num">
                        {l.unit_price != null ? formatCurrency(Number(l.unit_price)) : ""}
                      </TableCell>
                      <TableCell className="text-right font-mono num">{l.qty ?? ""}</TableCell>
                      <TableCell className="text-right font-mono num text-ink">
                        {l.amount != null ? formatCurrency(Number(l.amount)) : ""}
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          )}
          <div className="px-3 py-2 space-y-1 border-t border-line text-[12px]">
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
            {/* applied payments bridge the total to the balance */}
            {payments.map((p) => (
              <div key={p.qbo_payment_id} className="flex items-center gap-2 text-ink-dim" title={p.memo ?? undefined}>
                <span>
                  Payment #{p.qbo_payment_id}
                  <span className="text-ink-mute"> · {p.txn_date ?? ""}{p.payment_method_name ? ` · ${p.payment_method_name}` : ""}</span>
                </span>
                <span className="ml-auto font-mono num text-grass">−{formatCurrency(Number(p.applied_amount ?? 0))}</span>
              </div>
            ))}
            <div className={cn("flex justify-between font-medium", paid ? "text-grass" : "text-sun")}>
              <span>Balance</span>
              <span className="font-mono num">{formatCurrency(Number(inv.balance ?? 0))}</span>
            </div>
          </div>
        </div>

        <HistoryTimeline rows={invoiceHistoryRows(history)} title="History" emptyText="No events — this invoice predates the machine." />
      </div>
    </Dialog>
  )
}
