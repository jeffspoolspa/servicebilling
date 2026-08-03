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
import { HistoryTimeline, type HistoryRow } from "@/components/ui/history-timeline"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"
import { ServiceLog, type ServiceLogVisit } from "../../_components/service-log"
import { MONTH_STAGES, stepperStage, type MonthOverviewRow } from "../_lib/months"

/**
 * The billing-month workbench — the month's detail in the work-order-detail
 * shape: header, progression, then TABS — one per INVOICE (with its sent
 * and paid status) plus the Billing month tab holding the history table
 * (every event where the month is aggregate or participant) and the
 * ServiceLog. Pre-issue months show a Draft invoice tab instead, with the
 * itemized/summary flip. RULED: the month's own lifecycle ends at invoice
 * creation — everything after is its invoices' story, folded back here.
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

export interface InvoiceDetail {
  qbo_invoice_id: string
  doc_number: string | null
  txn_date: string | null
  subtotal: number | null
  total_amt: number | null
  balance: number | null
  email_status: string | null
  line_items: { name?: string; item?: string; description?: string; qty?: number; quantity?: number; unit_price?: number; amount?: number }[] | null
}

type DocLine =
  | { kind: "visit_break"; serviceDate: string }
  | { kind: "labor" | "consumable" | "variance"; itemName: string; qty: number; unitPriceCents: number; amountCents: number; serviceDate: string | null; detail: string | null }
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
}: {
  m: MonthOverviewRow
  visits: ServiceLogVisit[]
  history: HistoryEvent[]
  invoices: InvoiceDetail[]
}) {
  const monthLabel = m.month.slice(0, 7)
  const [tab, setTab] = useState<string>("month")
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

  return (
    <div className="space-y-4">
      {/* header */}
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

      <div className="flex items-center gap-3">
        <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(m.status)} className="max-w-[560px]" />
        {m.status === "disputed" && <Pill tone="coral">disputed</Pill>}
        {m.status === "held" && <Pill tone="sun">held</Pill>}
        <span className="ml-auto font-mono num text-[17px] text-ink">{formatCurrency(m.subtotal_cents / 100)}</span>
      </div>

      {/* tabs: the month, then one per invoice (or the draft) */}
      <div className="flex gap-1 border-b border-line-soft">
        <button
          onClick={() => setTab("month")}
          className={cn(
            "px-3.5 py-2 text-[13px] -mb-px border-b-2",
            tab === "month" ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
          )}
        >
          Billing month
        </button>
        {invoices.map((inv) => {
          const paid = (inv.balance ?? 1) <= 0
          const sent = inv.email_status === "EmailSent"
          const key = inv.qbo_invoice_id
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "px-3.5 py-2 text-[13px] -mb-px border-b-2 inline-flex items-center gap-1.5",
                tab === key ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
              )}
            >
              Inv {inv.doc_number ?? key}
              <Pill tone={sent ? "grass" : "neutral"}>{sent ? "sent" : "not sent"}</Pill>
              <Pill tone={paid ? "grass" : "sun"}>{paid ? "paid" : "open"}</Pill>
            </button>
          )
        })}
        {!hasInvoices && (
          <button
            onClick={() => setTab("draft")}
            className={cn(
              "px-3.5 py-2 text-[13px] -mb-px border-b-2",
              tab === "draft" ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
            )}
          >
            Draft invoice
          </button>
        )}
      </div>

      {/* ------------------------------ month tab ------------------------------ */}
      {tab === "month" && (
        <div className="space-y-4">
          <HistoryTimeline
            rows={monthHistoryRows(history)}
            title="History"
            emptyText="No events yet — the month has not been advanced."
          />

          <ServiceLog
            visits={visits}
            period={{
              label: monthLabel,
              start: `${monthLabel}-01`,
              end: new Date(Date.UTC(+monthLabel.slice(0, 4), +monthLabel.slice(5, 7), 0)).toISOString().slice(0, 10),
            }}
          />
        </div>
      )}

      {/* ----------------------------- invoice tabs ---------------------------- */}
      {invoices
        .filter((inv) => tab === inv.qbo_invoice_id)
        .map((inv) => (
          <div key={inv.qbo_invoice_id} className="rounded-lg border border-line-soft overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2.5 bg-white/[0.02] border-b border-line-soft text-[12px]">
              <span className="text-ink font-medium">Invoice {inv.doc_number ?? inv.qbo_invoice_id}</span>
              {inv.txn_date && <span className="font-mono text-ink-mute">{inv.txn_date}</span>}
              <span className="ml-auto flex items-center gap-4">
                <span className="text-ink-mute">
                  Total <span className="font-mono num text-ink">{formatCurrency(Number(inv.total_amt ?? 0))}</span>
                </span>
                <span className="text-ink-mute">
                  Balance <span className={cn("font-mono num", (inv.balance ?? 0) > 0 ? "text-sun" : "text-grass")}>{formatCurrency(Number(inv.balance ?? 0))}</span>
                </span>
              </span>
            </div>
            <Table className="text-[11.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(inv.line_items ?? []).map((l, i) => (
                  <TableRow key={i} className="text-ink-dim">
                    <TableCell>
                      {l.name ?? l.item ?? "—"}
                      {l.description && <span className="ml-2 text-ink-mute">{l.description}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono num">{l.qty ?? l.quantity ?? ""}</TableCell>
                    <TableCell className="text-right font-mono num">{l.unit_price != null ? formatCurrency(Number(l.unit_price)) : ""}</TableCell>
                    <TableCell className="text-right font-mono num text-ink">{l.amount != null ? formatCurrency(Number(l.amount)) : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="text-ink hover:bg-transparent">
                  <TableCell>Subtotal</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right font-mono num font-semibold">{formatCurrency(Number(inv.subtotal ?? 0))}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        ))}

      {/* ------------------------------ draft tab ------------------------------ */}
      {!hasInvoices && tab === "draft" && (
        <div className="rounded-lg border border-line-soft overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-white/[0.02] border-b border-line-soft">
            <span className="text-[11px] text-ink font-medium">
              Draft — regenerated from the ledger on every view
            </span>
            <div className="flex border border-line rounded-lg overflow-hidden">
              <button onClick={() => setPresentation("itemized")} className={`h-[22px] px-2 text-[10.5px] font-semibold ${seg((presentation ?? (draft !== "loading" && draft !== "error" && draft ? draft.presentation : "itemized")) === "itemized")}`}>Itemized</button>
              <button onClick={() => setPresentation("summary")} className={`h-[22px] px-2 text-[10.5px] font-semibold border-l border-line ${seg((presentation ?? (draft !== "loading" && draft !== "error" && draft ? draft.presentation : "itemized")) === "summary")}`}>Summary</button>
            </div>
          </div>
          {draft === "loading" && <div className="px-4 py-6 text-center text-[12px] text-ink-mute">Building the draft…</div>}
          {draft === "error" && <div className="px-4 py-6 text-center text-[12px] text-coral">Failed to build the draft.</div>}
          {draft && draft !== "loading" && draft !== "error" &&
            draft.documents.map((doc, d) => (
              <div key={d}>
                {draft.documents.length > 1 && (
                  <div className="px-4 pt-2.5 pb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-cyan">
                    {doc.kind} · {formatCurrency(doc.subtotalCents / 100)}
                  </div>
                )}
                {doc.lines.map((ln, idx) =>
                  ln.kind === "visit_break" ? (
                    <div key={idx} className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-white/[0.015]">
                      {ln.serviceDate}
                    </div>
                  ) : (
                    <div key={idx} className="flex items-center gap-2.5 border-b border-line-soft px-4 py-1.5">
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] text-ink">{ln.itemName}</span>
                        <span className="ml-2 font-mono text-[10px] text-ink-mute">
                          {ln.kind === "variance" ? ln.detail : `${ln.qty} × ${formatCurrency(ln.unitPriceCents / 100)}`}
                        </span>
                      </div>
                      <span className="font-mono num text-[12px] text-ink">{formatCurrency(ln.amountCents / 100)}</span>
                    </div>
                  ),
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
