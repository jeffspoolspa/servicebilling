"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Pill } from "@/components/ui/pill"
import { StatusStepper } from "@/components/ui/status-stepper"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { HistoryTimeline, type HistoryRow } from "@/components/ui/history-timeline"
import { formatCurrency } from "@/lib/utils/format"
import { visitBreakLabel } from "@/lib/billing/domain/invoice-documents"
import { cn } from "@/lib/utils/cn"
import { ServiceLog, type ServiceLogVisit } from "../../_components/service-log"
import { MONTH_STAGES, stepperStage, type MonthOverviewRow } from "../_lib/months"
import {
  InvoiceDetailModal,
  type AppliedPayment,
  type InvoiceDetail,
  type InvoiceEvent,
} from "./invoice-detail-modal"
import { PaymentMethodBadge, type PaymentMethodRef } from "@/components/ui/payment-method"

/**
 * The billing-month workbench — the month's detail in the work-order-detail
 * shape: header, progression, the month tab (history + ServiceLog, now
 * full-width — the visits get the room), and pre-issue a Draft tab with
 * the itemized/summary flip. Issued INVOICES live in the right-rail
 * Invoices card; clicking one opens the invoice DETAIL MODAL (the cached
 * document formatted, its applied payments, its machine history). The
 * payment method lives on each invoice now — the old placeholder card is
 * gone. RULED: the month's own lifecycle ends at invoice creation —
 * everything after is its invoices' story, folded back here.
 */

export interface HistoryEvent {
  seq: number
  occurred_at: string
  aggregate: string
  aggregate_id: string
  type: string
  actor: string | null
  payload: Record<string, unknown> | null
}

export type { InvoiceDetail }

type DocLine =
  | { kind: "visit_break"; serviceDate: string }
  | { kind: "labor" | "consumable" | "variance"; itemName: string; qty: number; unitPriceCents: number; amountCents: number; serviceDate: string | null; detail: string | null; description?: string | null }
interface Draft {
  subtotalCents: number
  claimedAtZero: number
  presentation: "itemized" | "summary"
  documents: { kind: string; lines: DocLine[]; subtotalCents: number }[]
}

/**
 * The month's vocabulary -> shared history rows, with SERIOUS filtering:
 * accrual churn (SourceClaimed/SourceReleased bursts — hundreds per re-run)
 * collapses to one row per type per run-minute with the count and dollars;
 * lifecycle and money events render individually. Same renderer as the
 * service-billing invoice history, so every aggregate reads the same way.
 */
function monthHistoryRows(history: HistoryEvent[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  const bursts = new Map<string, { count: number; cents: number; at: string; seq: number; type: string; reason: string | null }>()

  for (const e of history) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (e.type === "SourceClaimed" || e.type === "SourceReleased") {
      // Collapse per (type, minute) — one accrual pass lands in one burst.
      const key = `${e.type}|${e.occurred_at.slice(0, 16)}`
      const b = bursts.get(key) ?? { count: 0, cents: 0, at: e.occurred_at, seq: e.seq, type: e.type, reason: null }
      b.count++
      b.cents += Number((p as { amountCents?: number }).amountCents ?? 0)
      if (typeof p.reason === "string") b.reason = p.reason
      bursts.set(key, b)
      continue
    }

    const base = { key: `e${e.seq}`, at: e.occurred_at, seq: e.seq, tag: e.actor === "billing_pipeline" ? "pipeline" : e.actor?.includes("@") ? e.actor.split("@")[0] : e.actor ?? "system" }
    switch (e.type) {
      case "MonthReconciled":
        rows.push({ ...base, action: <>Reconciled — totals agree with ION<span className="text-ink-dim"> · {p.items as number} items · {formatCurrency(Number(p.subtotalCents ?? 0) / 100)}</span></> })
        break
      case "MonthDisputed":
        rows.push({ ...base, action: "Disputed — totals disagree", note: Array.isArray(p.reasons) ? (p.reasons as string[]).join("; ") : null })
        break
      case "DeliveryRefreshed":
        rows.push({ ...base, action: "Delivery re-read from ION" })
        break
      case "MonthGated": {
        const held = Array.isArray(p.heldFor) ? (p.heldFor as string[]) : []
        rows.push({
          ...base,
          action: held.length === 0 ? "Cleared the gate" : `Held by the gate`,
          checks: held.length > 0 ? held.map((h) => [h, false] as [string, boolean]) : undefined,
        })
        break
      }
      case "MonthInvoiced":
        rows.push({ ...base, action: "Invoice created — the ledger is frozen" })
        break
      case "MonthPreprocessed":
        rows.push({ ...base, action: <>Preprocessed<span className="text-ink-dim"> · route: {String(p.route ?? "—")}{Number(p.appliedCredits ?? 0) > 0 ? ` · ${p.appliedCredits} credit(s) applied` : ""}</span></> })
        break
      case "MonthSent":
        rows.push({ ...base, action: "Sent to the customer" })
        break
      case "VarianceRecorded":
        rows.push({ ...base, action: <>Variance recorded<span className="text-ink-dim"> · {String(p.kind ?? "")} · {formatCurrency(Number(p.deltaCents ?? 0) / 100)}</span></>, note: typeof p.reason === "string" ? p.reason : null })
        break
      case "ChemProvisionChanged":
        rows.push({ ...base, action: <>Peer group reassigned<span className="text-ink-dim"> · {String(p.provision ?? "")}</span></> })
        break
      default:
        rows.push({ ...base, action: e.type.replace(/_/g, " "), note: JSON.stringify(e.payload).slice(0, 140) })
    }
  }

  for (const b of bursts.values()) {
    rows.push({
      key: `b${b.type}${b.at}`,
      at: b.at,
      seq: b.seq,
      tag: "pipeline",
      action: (
        <>
          {b.type === "SourceClaimed" ? "Sources claimed" : "Sources released"}
          <span className="text-ink-dim"> · {b.count} item{b.count === 1 ? "" : "s"}{b.cents > 0 ? ` · ${formatCurrency(b.cents / 100)}` : ""}</span>
        </>
      ),
      note: b.type === "SourceReleased" ? b.reason : null,
    })
  }

  return rows.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : (b.seq ?? 0) - (a.seq ?? 0)))
}

export function MonthWorkbench({
  m,
  visits,
  history,
  invoices,
  invoicePayments,
  invoiceHistory,
  invoiceMethods,
}: {
  m: MonthOverviewRow
  visits: ServiceLogVisit[]
  history: HistoryEvent[]
  invoices: InvoiceDetail[]
  invoicePayments: Record<string, AppliedPayment[]>
  invoiceHistory: Record<string, InvoiceEvent[]>
  invoiceMethods: Record<string, PaymentMethodRef | null>
}) {
  const monthLabel = m.month.slice(0, 7)
  const [tab, setTab] = useState<string>("month")
  const [openInvoice, setOpenInvoice] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | "loading" | "error" | null>(null)
  const [presentation, setPresentation] = useState<"itemized" | "summary" | null>(null)

  const hasInvoices = invoices.length > 0

  // Pre-issue: the Draft tab fetches the on-demand projection.
  useEffect(() => {
    if (hasInvoices || tab !== "draft") return
    let alive = true
    setDraft("loading")
    const q = presentation ? `?presentation=${presentation}` : ""
    fetch(`/api/billing/months/${m.id}/draft-invoice${q}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setDraft(j as Draft))
      .catch(() => alive && setDraft("error"))
    return () => {
      alive = false
    }
  }, [tab, presentation, m.id, hasInvoices])

  const seg = (on: boolean) => (on ? "bg-cyan text-bg" : "bg-transparent text-ink-dim")

  const allPayments = invoices.flatMap((inv) => (invoicePayments[inv.qbo_invoice_id] ?? []).map((p) => ({ inv, p })))

  const fold = {
    totalBalance: invoices.reduce((s, i) => s + Number(i.balance ?? 0), 0),
    total: invoices.reduce((s, i) => s + Number(i.total_amt ?? 0), 0),
    allSent: invoices.length > 0 && invoices.every((i) => i.email_status === "EmailSent"),
    allPaid: invoices.length > 0 && invoices.every((i) => (i.balance ?? 1) <= 0),
  }

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className="text-[13px] text-ink mt-0.5">{children}</div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Billing month · {monthLabel}</div>
          <h2 className="font-display text-[18px] mt-0.5">{m.customer_name ?? m.customer_id}</h2>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          {m.open_findings > 0 && (
            <Link
              href={`/maintenance/billing/findings/${m.customer_id}?month=${monthLabel}` as never}
              className="text-sun hover:brightness-110 underline underline-offset-2"
            >
              {m.open_findings} open finding{m.open_findings === 1 ? "" : "s"}
            </Link>
          )}
          <Link href={`/maintenance/billing?month=${monthLabel}` as never} className="text-ink-mute hover:text-ink underline underline-offset-2">
            Back to months
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        {/* ------------------------------- LEFT ------------------------------- */}
        <div className="space-y-4 min-w-0">
          <Card>
            {/* the document card: tabs in the header, like WO | INVOICE */}
            <div className="flex items-center gap-4 px-5 pt-3 border-b border-line-soft flex-wrap">
              <button
                onClick={() => setTab("month")}
                className={cn(
                  "pb-2.5 -mb-px border-b-2 text-[12px] uppercase tracking-[0.08em]",
                  tab === "month" ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
                )}
              >
                Billing month {monthLabel}
              </button>
              {!hasInvoices && (
                <button
                  onClick={() => setTab("draft")}
                  className={cn(
                    "pb-2.5 -mb-px border-b-2 text-[12px] uppercase tracking-[0.08em]",
                    tab === "draft" ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
                  )}
                >
                  Draft invoice
                </button>
              )}
              <span className="ml-auto flex items-center gap-1.5 pb-2">
                {m.status === "disputed" && <Pill tone="coral">disputed</Pill>}
                {m.status === "held" && <Pill tone="sun">held</Pill>}
                <Pill tone="cyan">{m.status}</Pill>
              </span>
            </div>

            {/* month tab: field grid + progression + service log */}
            {tab === "month" && (
              <CardBody className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
                  <Field label="Customer">{m.customer_name ?? m.customer_id}</Field>
                  <Field label="Month">{monthLabel}</Field>
                  <Field label="Items">{m.item_count}</Field>
                  <Field label="Subtotal">
                    <span className="font-mono num">{formatCurrency(m.subtotal_cents / 100)}</span>
                  </Field>
                </div>
                <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(m.status)} />
                <ServiceLog
                  visits={visits}
                  onOpenInvoice={setOpenInvoice}
                  period={{
                    label: monthLabel,
                    start: `${monthLabel}-01`,
                    end: new Date(Date.UTC(+monthLabel.slice(0, 4), +monthLabel.slice(5, 7), 0)).toISOString().slice(0, 10),
                  }}
                />
              </CardBody>
            )}

            {/* draft tab */}
            {!hasInvoices && tab === "draft" && (
              <CardBody className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink-mute">Draft — regenerated from the ledger on every view</span>
                  <div className="flex border border-line rounded-lg overflow-hidden">
                    <button onClick={() => setPresentation("itemized")} className={`h-[22px] px-2 text-[10.5px] font-semibold ${seg((presentation ?? (draft && draft !== "loading" && draft !== "error" ? draft.presentation : "itemized")) === "itemized")}`}>Itemized</button>
                    <button onClick={() => setPresentation("summary")} className={`h-[22px] px-2 text-[10.5px] font-semibold border-l border-line ${seg((presentation ?? (draft && draft !== "loading" && draft !== "error" ? draft.presentation : "itemized")) === "summary")}`}>Summary</button>
                  </div>
                </div>
                {draft === "loading" && <div className="py-6 text-center text-[12px] text-ink-mute">Building the draft…</div>}
                {draft === "error" && <div className="py-6 text-center text-[12px] text-coral">Failed to build the draft.</div>}
                {draft && draft !== "loading" && draft !== "error" &&
                  draft.documents.map((doc, d) => (
                    <div key={d} className="rounded border border-line-soft overflow-hidden">
                      {draft.documents.length > 1 && (
                        <div className="px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-cyan bg-white/[0.02]">
                          {doc.kind} · {formatCurrency(doc.subtotalCents / 100)}
                        </div>
                      )}
                      {doc.lines.map((ln, idx) =>
                        ln.kind === "visit_break" ? (
                          <div key={idx} className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-white/[0.015]">
                            {visitBreakLabel(ln.serviceDate)}
                          </div>
                        ) : (
                          <div key={idx} className="flex items-center gap-2.5 border-b border-line-soft/60 last:border-b-0 px-3 py-1.5">
                            <div className="flex-1 min-w-0">
                              <span className={ln.itemName ? "text-[12px] text-ink" : "text-[12px] text-ink-mute"}>{ln.itemName || "—"}</span>
                              <span className="ml-2 font-mono text-[10px] text-ink-mute">
                                {ln.kind === "variance" ? ln.detail : `${ln.qty} × ${formatCurrency(ln.unitPriceCents / 100)}`}
                              </span>
                              <div className={ln.description ? "text-[10.5px] text-ink-dim" : "text-[10.5px] text-coral"}>
                                {ln.description || "no description — issue will refuse"}
                              </div>
                            </div>
                            <span className="font-mono num text-[12px] text-ink">{formatCurrency(ln.amountCents / 100)}</span>
                          </div>
                        ),
                      )}
                    </div>
                  ))}
              </CardBody>
            )}
          </Card>

          {/* payments & credits — QBO's own linkage, across the month's invoices */}
          <Card>
            <CardHeader>
              <CardTitle>Payments &amp; credits</CardTitle>
            </CardHeader>
            <CardBody className="text-sm">
              {allPayments.length === 0 ? (
                <span className="text-ink-mute">
                  {hasInvoices
                    ? "No payments or credits touch these invoices yet."
                    : "Payments and credits appear once the invoice exists — credit checks and payment resolution run per invoice."}
                </span>
              ) : (
                <div className="space-y-1.5">
                  {allPayments.map(({ inv, p }) => (
                    <div key={`${inv.qbo_invoice_id}-${p.qbo_payment_id}`} className="flex items-center gap-2.5 text-[12px]">
                      <span className="text-ink">Payment #{p.qbo_payment_id}</span>
                      <span className="font-mono text-[10px] text-ink-mute">{p.txn_date ?? ""}</span>
                      {p.payment_method_name && <span className="text-[10.5px] text-ink-dim">{p.payment_method_name}</span>}
                      <button
                        onClick={() => setOpenInvoice(inv.qbo_invoice_id)}
                        className="font-mono text-[10px] text-ink-mute hover:text-cyan underline underline-offset-2"
                      >
                        {inv.doc_number}
                      </button>
                      <span className="ml-auto font-mono num text-grass">{formatCurrency(Number(p.applied_amount ?? 0))}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------- RIGHT ------------------------------ */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <span className="ml-auto">
                {m.status === "closed" ? <Pill tone="grass">closed</Pill> : <Pill tone="cyan">{m.status}</Pill>}
              </span>
            </CardHeader>
            <CardBody className="space-y-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-ink-mute">Subtotal</span>
                <span className="font-mono num">{formatCurrency(m.subtotal_cents / 100)}</span>
              </div>
              {hasInvoices && (
                <>
                  <div className="flex justify-between">
                    <span className="text-ink-mute">Invoiced</span>
                    <span className="font-mono num">{formatCurrency(fold.total)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-mute">Balance</span>
                    <span className={cn("font-mono num", fold.totalBalance > 0 ? "text-sun" : "text-grass")}>{formatCurrency(fold.totalBalance)}</span>
                  </div>
                </>
              )}
              {m.open_findings > 0 && (
                <div className="flex justify-between">
                  <span className="text-ink-mute">Open findings</span>
                  <Pill tone="sun">{m.open_findings}</Pill>
                </div>
              )}
            </CardBody>
          </Card>

          {/* the month's invoices — click for the full detail modal; the
              payment method rides each invoice's memo and machine now */}
          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            {!hasInvoices ? (
              <CardBody>
                <span className="text-[12.5px] text-ink-mute">None issued — the draft is the preview.</span>
              </CardBody>
            ) : (
              <Table className="text-[11.5px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow
                      key={inv.qbo_invoice_id}
                      onClick={() => setOpenInvoice(inv.qbo_invoice_id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-ink">{inv.doc_number ?? inv.qbo_invoice_id}</TableCell>
                      <TableCell>
                        <Pill tone={inv.email_status === "EmailSent" ? "grass" : "neutral"}>
                          {inv.email_status === "EmailSent" ? "sent" : "not sent"}
                        </Pill>
                      </TableCell>
                      <TableCell>
                        <PaymentMethodBadge method={invoiceMethods[inv.qbo_invoice_id]} />
                      </TableCell>
                      <TableCell className={cn("text-right font-mono num", (inv.balance ?? 0) > 0 ? "text-sun" : "text-grass")}>
                        {formatCurrency(Number(inv.balance ?? 0))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <HistoryTimeline
            rows={monthHistoryRows(history)}
            title="History"
            emptyText="No events yet — the month has not been advanced."
          />
        </div>
      </div>

      <InvoiceDetailModal
        invoice={invoices.find((i) => i.qbo_invoice_id === openInvoice) ?? null}
        payments={openInvoice ? (invoicePayments[openInvoice] ?? []) : []}
        history={openInvoice ? (invoiceHistory[openInvoice] ?? []) : []}
        onClose={() => setOpenInvoice(null)}
      />
    </div>
  )
}
