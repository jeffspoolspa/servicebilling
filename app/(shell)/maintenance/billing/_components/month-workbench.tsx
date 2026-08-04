"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Pill } from "@/components/ui/pill"
import { StatusStepper } from "@/components/ui/status-stepper"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
  type InvoiceLineItem,
} from "./invoice-detail-modal"
import { PaymentMethodBadge, type PaymentMethodRef } from "@/components/ui/payment-method"

/**
 * The billing-month workbench. The CUSTOMER card sits ABOVE this (rendered
 * by the page, same as the work-order detail). Here: the BILLING MONTH
 * card — high-level details, the progression, and the ACTION ITEMS the
 * month's state makes available (release hold / issue / run machine /
 * review findings) — then the draft (pre-issue) and the ServiceLog as
 * their own cards. Invoices and Payments & credits live in the right
 * rail; clicking either opens the invoice detail modal. RULED: the
 * month's own lifecycle ends at invoice creation — everything after is
 * its invoices' story, folded back here.
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

export interface LedgerItem {
  kind: "labor" | "consumable" | string
  bucket: "service" | "consumables" | "green" | string
  item_name: string | null
  qty: number
  unit_price_cents: number
  amount_cents: number
  service_date: string | null
  visit_id: string | null
  qbo_invoice_id: string | null
}

export interface MonthTask {
  task_id: string
  service_name: string | null
  category: string | null
  billing_method: string | null
  price_per_visit_cents: number | null
  flat_rate_monthly_cents: number | null
  consumables_mode: string | null
  ion_invoice_type: string | null
  visit_count: number
}

type DocLine =
  | { kind: "visit_break"; serviceDate: string }
  | { kind: "labor" | "consumable" | "variance"; itemName: string; qty: number; unitPriceCents: number; amountCents: number; serviceDate: string | null; detail: string | null; description?: string | null }
interface Draft {
  subtotalCents: number
  claimedAtZero: number
  presentation: "itemized" | "summary"
  documents: { kind: string; docNumber?: string | null; lines: DocLine[]; subtotalCents: number }[]
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
  ledgerItems,
  monthTasks,
}: {
  m: MonthOverviewRow
  visits: ServiceLogVisit[]
  history: HistoryEvent[]
  invoices: InvoiceDetail[]
  invoicePayments: Record<string, AppliedPayment[]>
  invoiceHistory: Record<string, InvoiceEvent[]>
  invoiceMethods: Record<string, PaymentMethodRef | null>
  ledgerItems: LedgerItem[]
  monthTasks: MonthTask[]
}) {
  const router = useRouter()
  const monthLabel = m.month.slice(0, 7)
  const [openInvoice, setOpenInvoice] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | "loading" | "error" | null>(null)
  const [presentation, setPresentation] = useState<"itemized" | "summary" | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [actErr, setActErr] = useState<string | null>(null)

  const hasInvoices = invoices.length > 0

  // Pre-issue: the draft card fetches the on-demand projection.
  useEffect(() => {
    if (hasInvoices) return
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
  }, [presentation, m.id, hasInvoices])

  const act = async (name: string, method: string, path: string) => {
    setActing(name)
    setActErr(null)
    try {
      const r = await fetch(path, { method })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(String(j.error ?? `${r.status}`))
      router.refresh()
    } catch (e) {
      setActErr(`${name} failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`)
    } finally {
      setActing(null)
    }
  }

  const seg = (on: boolean) => (on ? "bg-cyan text-bg" : "bg-transparent text-ink-dim")

  const fold = {
    totalBalance: invoices.reduce((s, i) => s + Number(i.balance ?? 0), 0),
    total: invoices.reduce((s, i) => s + Number(i.total_amt ?? 0), 0),
  }
  const allPayments = invoices.flatMap((inv) => (invoicePayments[inv.qbo_invoice_id] ?? []).map((p) => ({ inv, p })))

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className="text-[13px] text-ink mt-0.5">{children}</div>
    </div>
  )

  // The LOCKED document-shaping settings, read from the agreements: the
  // presentation (ION invoice type) and whether consumables split to their
  // own document. Changing them means changing the task in ION — every
  // draft regenerates on next read by construction.
  const lockedPresentation: "itemized" | "summary" =
    (draft && draft !== "loading" && draft !== "error" ? draft.presentation : null) ??
    ((monthTasks.find((t) => t.ion_invoice_type)?.ion_invoice_type ?? "").toLowerCase().includes("summary") ? "summary" : "itemized")
  const separateConsumables = monthTasks.some((t) => (t.consumables_mode ?? "").toLowerCase().includes("separate")) || ledgerItems.some((i) => i.bucket === "consumables")

  // bucket -> doc number: the issued invoice's, else the draft projection's
  const docNumberOf = (bucket: string): { label: string | null; open: (() => void) | null } => {
    const kindOf = (k: string) => (bucket === "service" ? k === "service" : bucket === k)
    const issuedRow = (m.issued_invoices ?? []).find((r) => kindOf(r.kind))
    if (issuedRow) return { label: issuedRow.doc_number, open: () => setOpenInvoice(issuedRow.qbo_invoice_id) }
    if (draft && draft !== "loading" && draft !== "error") {
      const d = draft.documents.find((dd) => kindOf(dd.kind))
      if (d?.docNumber) return { label: `${d.docNumber} · draft`, open: () => setOpenInvoice(`draft:${d.kind}`) }
    }
    return { label: null, open: null }
  }

  // the ledger, grouped for display: summary collapses identical item+rate;
  // itemized keeps per-date rows — the SAME logic the documents follow.
  const groupItems = (
    items: LedgerItem[],
  ): { name: string; qty: number; rate: number; amount: number; date: string | null; visits: number; invoice: string | null }[] => {
    if (lockedPresentation === "summary") {
      const g = new Map<string, { name: string; qty: number; rate: number; amount: number; date: null; visitSet: Set<string>; invoice: string | null }>()
      for (const it of items) {
        // the group key includes the item's OWN invoice — items on different
        // documents never merge, so the linkage stays exact under grouping
        const key = `${it.item_name}|${it.unit_price_cents}|${it.qbo_invoice_id ?? "draft"}`
        const row = g.get(key) ?? { name: it.item_name ?? "—", qty: 0, rate: it.unit_price_cents / 100, amount: 0, date: null, visitSet: new Set<string>(), invoice: it.qbo_invoice_id }
        row.qty += it.kind === "labor" ? 1 : Number(it.qty)
        row.amount += it.amount_cents / 100
        if (it.visit_id) row.visitSet.add(it.visit_id)
        g.set(key, row)
      }
      return [...g.values()]
        .map(({ visitSet, ...r }) => ({ ...r, visits: visitSet.size }))
        .sort((a, b) => b.amount - a.amount)
    }
    return items.map((it) => ({
      name: it.item_name ?? "—",
      qty: Number(it.qty),
      rate: it.unit_price_cents / 100,
      amount: it.amount_cents / 100,
      date: it.service_date,
      visits: it.visit_id ? 1 : 0,
      invoice: it.qbo_invoice_id,
    }))
  }
  const laborItems = ledgerItems.filter((i) => i.kind === "labor" && i.amount_cents !== 0)
  const chemItems = ledgerItems.filter((i) => i.kind === "consumable")

  const actionBtn = "h-8 px-3 rounded-lg border border-line bg-bg-elev text-ink-dim text-[12px] font-medium hover:border-cyan hover:text-cyan disabled:opacity-50"
  const primaryBtn = "h-8 px-3.5 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        {/* ------------------------------- LEFT ------------------------------- */}
        <div className="space-y-4 min-w-0">
          {/* the BILLING MONTH card: high-level details + action items */}
          <Card>
            <CardHeader>
              <CardTitle>Billing month · {monthLabel}</CardTitle>
              <span className="ml-auto flex items-center gap-1.5">
                {m.status === "disputed" && <Pill tone="coral">disputed</Pill>}
                {m.status === "held" && <Pill tone="sun">held</Pill>}
                <Pill tone={m.status === "closed" ? "grass" : "cyan"}>{m.status}</Pill>
              </span>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
                <Field label="Items">{m.item_count}</Field>
                <Field label="Subtotal">
                  <span className="font-mono num">{formatCurrency(m.subtotal_cents / 100)}</span>
                </Field>
                <Field label="Invoiced">
                  <span className="font-mono num">{hasInvoices ? formatCurrency(fold.total) : "—"}</span>
                </Field>
                <Field label="Balance">
                  <span className={cn("font-mono num", hasInvoices && fold.totalBalance > 0 ? "text-sun" : hasInvoices ? "text-grass" : "")}>
                    {hasInvoices ? formatCurrency(fold.totalBalance) : "—"}
                  </span>
                </Field>
              </div>
              <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(m.status)} />

              {/* what needs a person: held reasons, disputes, findings */}
              {((m.gate_held_for?.length ?? 0) > 0 || (m.disputes?.length ?? 0) > 0 || m.open_findings > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {(m.gate_held_for ?? []).map((h) => (
                    <Pill key={h} tone="sun">{h}</Pill>
                  ))}
                  {(m.disputes ?? []).map((d, i) => (
                    <span key={i} className="text-[11px] text-coral">{d}</span>
                  ))}
                  {m.open_findings > 0 && (
                    <Link
                      href={`/maintenance/billing/findings/${m.customer_id}?month=${monthLabel}` as never}
                      className="text-[12px] text-sun hover:brightness-110 underline underline-offset-2"
                    >
                      Review {m.open_findings} open finding{m.open_findings === 1 ? "" : "s"}
                    </Link>
                  )}
                </div>
              )}

              {/* the ACTIONS the state makes available */}
              <div className="flex items-center gap-2 flex-wrap">
                {m.status === "held" && (
                  <button disabled={acting !== null} onClick={() => act("Release hold", "DELETE", `/api/billing/months/${m.id}/hold`)} className={actionBtn}>
                    {acting === "Release hold" ? "Releasing…" : "Release hold"}
                  </button>
                )}
                {m.status === "gated" && !hasInvoices && (
                  <button disabled={acting !== null} onClick={() => act("Issue invoices", "POST", `/api/billing/months/${m.id}/issue`)} className={primaryBtn}>
                    {acting === "Issue invoices" ? "Issuing…" : "Issue invoices"}
                  </button>
                )}
                {hasInvoices && m.status !== "closed" && (
                  <button disabled={acting !== null} onClick={() => act("Run machine", "POST", `/api/billing/months/${m.id}/machine`)} className={actionBtn}>
                    {acting === "Run machine" ? "Running…" : "Run machine"}
                  </button>
                )}
                {actErr && <span className="text-[11px] text-coral">{actErr}</span>}
              </div>
            </CardBody>
          </Card>

          {/* TASKS with logs this month — the agreements shaping the documents */}
          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
            </CardHeader>
            {monthTasks.length === 0 ? (
              <CardBody><span className="text-[12.5px] text-ink-mute">No tasks logged visits this month.</span></CardBody>
            ) : (
              <Table className="text-[11.5px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Task</TableHead>
                    <TableHead>Terms</TableHead>
                    <TableHead>Consumables</TableHead>
                    <TableHead>Presentation</TableHead>
                    <TableHead className="text-right">Visits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthTasks.map((t) => (
                    <TableRow key={t.task_id} className="text-ink-dim">
                      <TableCell className="text-ink">
                        {t.service_name ?? "—"}
                        {t.category && t.category !== "recurring" && (
                          <span className="ml-1.5 font-mono text-[9.5px] text-ink-mute">{t.category.replace(/_/g, " ")}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[10.5px]">
                        {t.billing_method === "flat_rate"
                          ? `flat ${formatCurrency(Number(t.flat_rate_monthly_cents ?? 0) / 100)}/mo`
                          : t.price_per_visit_cents != null
                            ? `${formatCurrency(Number(t.price_per_visit_cents) / 100)}/visit`
                            : "—"}
                      </TableCell>
                      <TableCell>
                        <Pill tone={(t.consumables_mode ?? "").toLowerCase().includes("separate") ? "cyan" : "neutral"}>
                          {(t.consumables_mode ?? "").toLowerCase().includes("separate") ? "separate" : "included"}
                        </Pill>
                      </TableCell>
                      <TableCell className="text-[10.5px] text-ink-mute">{t.ion_invoice_type ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono num">{t.visit_count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          {/* the LEDGER: billable items split by document bucket, with the
              LOCKED shaping settings and each bucket's invoice number */}
          <Card>
            <CardHeader>
              <CardTitle>Billable items</CardTitle>
              <span
                className="ml-auto flex items-center gap-1.5"
                title="From the task agreement in ION — locked. Changing it regenerates any draft invoices on next read."
              >
                <span className="flex border border-line rounded-lg overflow-hidden opacity-70">
                  <span className={`h-[22px] px-2 text-[10.5px] font-semibold leading-[22px] ${lockedPresentation === "itemized" ? "bg-cyan text-bg" : "text-ink-dim"}`}>Itemized</span>
                  <span className={`h-[22px] px-2 text-[10.5px] font-semibold leading-[22px] border-l border-line ${lockedPresentation === "summary" ? "bg-cyan text-bg" : "text-ink-dim"}`}>Summary</span>
                </span>
                <Pill tone={separateConsumables ? "cyan" : "neutral"}>
                  {separateConsumables ? "separate consumables" : "consumables included"}
                </Pill>
              </span>
            </CardHeader>
            {ledgerItems.length === 0 ? (
              <CardBody><span className="text-[12.5px] text-ink-mute">Nothing claimed yet.</span></CardBody>
            ) : (
              [
                { key: "labor", label: "Labor", items: laborItems },
                { key: "chems", label: "Consumables", items: chemItems },
              ].map(({ key, label, items }) => {
                if (items.length === 0) return null
                const bucket = key === "chems" && separateConsumables ? "consumables" : items.some((i) => i.bucket === "green") ? "green" : "service"
                const doc = docNumberOf(bucket)
                const rows = groupItems(items)
                const subtotal = items.reduce((s2, i) => s2 + i.amount_cents, 0)
                return (
                  <div key={key} className="border-t border-line-soft first:border-t-0">
                    <div className="flex items-center gap-2 px-5 py-1.5">
                      <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">{label}</span>
                      {doc.label &&
                        (doc.open ? (
                          <button onClick={doc.open} className="font-mono text-[10px] text-ink-mute hover:text-cyan underline underline-offset-2">
                            {doc.label}
                          </button>
                        ) : (
                          <span className="font-mono text-[10px] text-ink-mute">{doc.label}</span>
                        ))}
                      <span className="ml-auto font-mono num text-[11px] text-ink-dim">{formatCurrency(subtotal / 100)}</span>
                    </div>
                    {rows.map((r, i) => {
                      const invDoc = r.invoice ? invoices.find((iv) => iv.qbo_invoice_id === r.invoice) : null
                      return (
                        <div key={i} className="flex items-center gap-2.5 border-t border-line-soft/50 px-5 py-1">
                          <span className="text-[11.5px] text-ink flex-1 min-w-0 truncate">{r.name}</span>
                          <span className="font-mono text-[9.5px] text-ink-mute flex-none w-[64px]">
                            {r.date ?? `${r.visits} visit${r.visits === 1 ? "" : "s"}`}
                          </span>
                          <span className="font-mono text-[10px] text-ink-mute flex-none">
                            {r.qty} × {formatCurrency(r.rate)}
                          </span>
                          <span className="w-[70px] flex-none text-right">
                            {r.invoice ? (
                              <button
                                onClick={() => setOpenInvoice(r.invoice!)}
                                className="font-mono text-[9.5px] text-ink-mute hover:text-cyan underline underline-offset-2"
                              >
                                {invDoc?.doc_number ?? r.invoice}
                              </button>
                            ) : (
                              <span className="font-mono text-[9.5px] text-ink-mute/50">{doc.label ?? "—"}</span>
                            )}
                          </span>
                          <span className="font-mono num text-[11.5px] text-ink w-[70px] text-right flex-none">{formatCurrency(r.amount)}</span>
                        </div>
                      )
                    })}
                  </div>
                )
              })
            )}
          </Card>

          {/* the LOGS card — its own component, full width */}
          <ServiceLog
            visits={visits}
            period={{
              label: monthLabel,
              start: `${monthLabel}-01`,
              end: new Date(Date.UTC(+monthLabel.slice(0, 4), +monthLabel.slice(5, 7), 0)).toISOString().slice(0, 10),
            }}
          />
        </div>

        {/* ------------------------------- RIGHT ------------------------------ */}
        <div className="space-y-4">
          {/* the month's invoices — click for the full detail modal */}
          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
            </CardHeader>
            <Table className="text-[11.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!hasInvoices &&
                  (draft && draft !== "loading" && draft !== "error" ? (
                    draft.documents.map((doc) => (
                      <TableRow key={doc.kind} onClick={() => setOpenInvoice(`draft:${doc.kind}`)} className="cursor-pointer">
                        <TableCell className="font-mono text-ink">{doc.docNumber ?? (draft.documents.length > 1 ? doc.kind : "draft")}</TableCell>
                        <TableCell>
                          <Pill tone="neutral">draft</Pill>
                        </TableCell>
                        <TableCell>
                          <span className="text-ink-mute">—</span>
                        </TableCell>
                        <TableCell className="text-right font-mono num text-ink-dim">
                          {formatCurrency(doc.subtotalCents / 100)}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="text-ink-mute">
                        {draft === "error" ? "Draft failed to build." : "Building the draft…"}
                      </TableCell>
                    </TableRow>
                  ))}
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
          </Card>

          {/* payments & credits — QBO's own linkage, across the month's invoices */}
          <Card>
            <CardHeader>
              <CardTitle>Payments &amp; credits</CardTitle>
            </CardHeader>
            <CardBody className="text-sm">
              {allPayments.length === 0 ? (
                <span className="text-[12.5px] text-ink-mute">
                  {hasInvoices ? "None touch these invoices yet." : "Appear once the invoice exists."}
                </span>
              ) : (
                <div className="space-y-1.5">
                  {allPayments.map(({ inv, p }) => (
                    <button
                      key={`${inv.qbo_invoice_id}-${p.qbo_payment_id}`}
                      onClick={() => setOpenInvoice(inv.qbo_invoice_id)}
                      className="w-full flex items-center gap-2 rounded px-2 py-1 -mx-2 text-left text-[12px] hover:bg-white/[0.03]"
                      title={p.memo ?? undefined}
                    >
                      <span className="text-ink">#{p.qbo_payment_id}</span>
                      <span className="font-mono text-[10px] text-ink-mute">{p.txn_date ?? ""}</span>
                      <span className="font-mono text-[10px] text-ink-mute">{inv.doc_number}</span>
                      <span className="ml-auto font-mono num text-grass">{formatCurrency(Number(p.applied_amount ?? 0))}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <HistoryTimeline
            rows={monthHistoryRows(history)}
            title="History"
            emptyText="No events yet — the month has not been advanced."
          />
        </div>
      </div>

      {openInvoice?.startsWith("draft:") && draft && draft !== "loading" && draft !== "error" ? (
        (() => {
          const doc = draft.documents.find((d) => `draft:${d.kind}` === openInvoice)
          if (!doc) return null
          const lines: InvoiceLineItem[] = doc.lines.map((ln) =>
            ln.kind === "visit_break"
              ? { line_type: "description", description: visitBreakLabel(ln.serviceDate) }
              : {
                  line_type: "item",
                  item_name: ln.itemName || "—",
                  description: ln.description ?? (ln.kind === "variance" ? ln.detail : null),
                  qty: ln.qty,
                  unit_price: ln.unitPriceCents / 100,
                  amount: ln.amountCents / 100,
                },
          )
          return (
            <InvoiceDetailModal
              invoice={{
                qbo_invoice_id: openInvoice,
                doc_number: doc.docNumber ?? null,
                customer_name: m.customer_name,
                txn_date: null,
                memo: `${new Date(m.month.slice(0, 7) + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} Pool Maintenance`,
                subtotal: doc.subtotalCents / 100,
                total_amt: null,
                balance: null,
                email_status: null,
                line_items: lines,
              }}
              payments={[]}
              history={[]}
              onClose={() => setOpenInvoice(null)}
              draft={{
                presentation: presentation ?? draft.presentation,
                onPresentation: setPresentation,
              }}
            />
          )
        })()
      ) : (
        <InvoiceDetailModal
          invoice={invoices.find((i) => i.qbo_invoice_id === openInvoice) ?? null}
          payments={openInvoice ? (invoicePayments[openInvoice] ?? []) : []}
          history={openInvoice ? (invoiceHistory[openInvoice] ?? []) : []}
          onClose={() => setOpenInvoice(null)}
        />
      )}
    </div>
  )
}
