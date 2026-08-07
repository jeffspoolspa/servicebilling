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
import { FcHistoryChart, ReadingsOverview, type FcHistoryPoint } from "../../_components/service-log/readings-overview"
import { VisitCalendar, type ChemItemCompareRow } from "./visit-calendar"
import { MONTH_STAGES, stepperStage, isHeld, type MonthOverviewRow } from "../_lib/months"
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
  id: string
  task_id: string | null
  excluded_at: string | null
  kind: "labor" | "consumable" | string
  bucket: "service" | "consumables" | "green" | string
  item_name: string | null
  qty: number
  unit_price_cents: number
  amount_cents: number
  service_date: string | null
  visit_id: string | null
  qbo_invoice_id: string | null
  qbo_line_id: string | null
}

export interface ExplainerNote {
  note: string
  by: string
  at: string
}

/** 'carter@jeffspoolspa.com' -> 'CA'; 'billing_pipeline' -> 'BP'. */
function initialsOf(by: string): string {
  const local = by.split("@")[0]
  const parts = local.split(/[._-]/).filter(Boolean)
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase()
}

export interface FollowUpRow {
  id: string
  created_at: string
  issue: string | null
  description: string | null
  status: string | null
  next_steps: string | null
  equipment_off: boolean | null
  source_tech_name: string | null
}

export interface MonthFinding {
  id: number
  rule: string
  severity: string | null
  message: string | null
  cents: number | null
  detected_at: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
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
  settings?: { consumables: "included" | "separate"; presentation: "itemized" | "summary" }
  settingsConflicts?: string[]
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
  const flagRaises: { at: string; seq: number; cents: number; message: string }[] = []
  const flagRetracts: { at: string; seq: number; reason: string }[] = []
  const flagSkips: { at: string; seq: number; message: string; reason: string }[] = []

  // GATE DEDUPE: the gate re-computes until invoiced, so an unchanged
  // outcome repeats nightly — only a CHANGED outcome is a fact worth a row.
  const gateKeep = new Set<number>()
  {
    let prevSig: string | null = null
    for (const g of [...history].filter((e) => e.type === "MonthGated").sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))) {
      const sig = JSON.stringify(((g.payload ?? {}) as { heldFor?: string[] }).heldFor ?? [])
      if (sig !== prevSig) gateKeep.add(g.seq)
      prevSig = sig
    }
  }

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
        if (!gateKeep.has(e.seq)) break
        const held = Array.isArray(p.heldFor) ? (p.heldFor as string[]) : []
        rows.push({
          ...base,
          action: held.length === 0 ? "Cleared the gate" : `Held by the gate`,
          checks: held.length > 0 ? held.map((h) => [h, false] as [string, boolean]) : undefined,
        })
        break
      }
      case "MonthInvoiced":
        rows.push({ ...base, action: "Month issued — the ledger is frozen" })
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
      case "MonthItemsExcluded":
        rows.push({ ...base, action: <>Items marked non-billable<span className="text-ink-dim"> · {Number(p.count ?? 0)} item{Number(p.count ?? 0) === 1 ? "" : "s"}</span></> })
        break
      case "MonthItemsRestored":
        rows.push({ ...base, action: <>Non-billable items restored<span className="text-ink-dim"> · {Number(p.count ?? 0)} item{Number(p.count ?? 0) === 1 ? "" : "s"}</span></> })
        break
      case "MonthDocSettingsChosen":
        rows.push({
          ...base,
          action: (
            <>
              Billing type chosen
              <span className="text-ink-dim">
                {" · "}
                {Object.entries((p.chosen ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(", ")}
              </span>
            </>
          ),
        })
        break
      // ── the invoice half of the story, as it names this month
      case "invoice_created":
        rows.push({
          ...base,
          action: (
            <>
              Invoice {typeof p.doc_number === "string" ? `#${p.doc_number} ` : ""}created
              {p.how === "already_existed" ? " — adopted the existing document" : ""}
              <span className="text-ink-dim"> · {formatCurrency(Number(p.subtotal_cents ?? 0) / 100)}</span>
            </>
          ),
        })
        break
      case "invoice_emailed":
        rows.push({ ...base, action: "Invoice emailed" })
        break
      case "invoice_deleted":
        rows.push({ ...base, action: "Invoice deleted", note: typeof p.reason === "string" ? p.reason : null })
        break
      case "invoice_attachment_uploaded":
        rows.push({ ...base, action: "Explainer letter attached", note: typeof p.filename === "string" ? p.filename : null })
        break
      case "charge_captured":
        rows.push({ ...base, action: <>Charge captured<span className="text-ink-dim"> · {formatCurrency(Number(p.amount_cents ?? 0) / 100)}</span></> })
        break
      case "charge_declined":
        rows.push({ ...base, action: "Charge declined", note: typeof p.reason === "string" ? p.reason : null })
        break
      case "credit_applied":
        rows.push({ ...base, action: "Credit applied" })
        break
      // ── the audit's flags — collapsed below into one row per kind
      case "VisitFlagRaised":
        flagRaises.push({ at: e.occurred_at, seq: e.seq, cents: Number(p.cents ?? 0), message: typeof p.message === "string" ? p.message : "" })
        break
      case "VisitFlagRetracted":
        flagRetracts.push({ at: e.occurred_at, seq: e.seq, reason: typeof p.reason === "string" ? p.reason : "" })
        break
      case "VisitFlagSkipped":
        flagSkips.push({ at: e.occurred_at, seq: e.seq, message: typeof p.message === "string" ? p.message : "", reason: typeof p.reason === "string" ? p.reason : "" })
        break
      default:
        // Outside the month's lens (observation echoes, credit-check passes,
        // schedule/task churn) — those live on their own surfaces.
        break
    }
  }

  // ALL flag raises fold into ONE row — the total up front, each visit and
  // its dollars behind the dropdown. Same for retractions.
  if (flagRaises.length > 0) {
    const latest = flagRaises.reduce((a, b) => (a.at > b.at ? a : b))
    const total = flagRaises.reduce((s, f) => s + f.cents, 0)
    rows.push({
      key: "flags-raised",
      at: latest.at,
      seq: latest.seq,
      tag: "pipeline",
      action: (
        <>
          {flagRaises.length === 1 ? "Visit flagged" : `${flagRaises.length} visits flagged`}
          <span className="text-ink-dim"> · {formatCurrency(total / 100)}</span>
        </>
      ),
      itemsSummary: "the visits",
      items: [...flagRaises]
        .sort((a, b) => (a.message < b.message ? -1 : 1))
        .map((f) => ({
          label: (
            <>
              <span className="font-mono">{f.message.slice(0, 10)}</span> · {formatCurrency(f.cents / 100)}
            </>
          ),
          note: f.message.slice(12) || null,
        })),
    })
  }
  if (flagSkips.length > 0) {
    const latest = flagSkips.reduce((a, b) => (a.at > b.at ? a : b))
    rows.push({
      key: "flags-skipped",
      at: latest.at,
      seq: latest.seq,
      tag: "pipeline",
      action: (
        <>
          {flagSkips.length === 1 ? "Flag skipped" : `${flagSkips.length} flags skipped`}
          <span className="text-ink-dim"> · {flagSkips[0].reason === "raised_after_issue" ? "raised after issue" : "issued with flags open"}</span>
        </>
      ),
      itemsSummary: "the visits",
      items: [...flagSkips]
        .sort((a, b) => (a.message < b.message ? -1 : 1))
        .map((f) => ({ label: <span className="font-mono">{f.message.slice(0, 10)}</span>, note: f.message.slice(12) || null })),
    })
  }
  if (flagRetracts.length > 0) {
    const latest = flagRetracts.reduce((a, b) => (a.at > b.at ? a : b))
    rows.push({
      key: "flags-retracted",
      at: latest.at,
      seq: latest.seq,
      tag: "pipeline",
      action: flagRetracts.length === 1 ? "Flag retracted" : `${flagRetracts.length} flags retracted`,
      itemsSummary: "why",
      items: flagRetracts.map((f) => ({ label: f.reason.replace(/_/g, " ") || "retracted" })),
    })
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
  findings,
  summaryNote,
  chemItemSummary,
  fcHistory,
  followUps,
  explainer,
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
  findings: MonthFinding[]
  summaryNote: string | null
  chemItemSummary: ChemItemCompareRow[]
  fcHistory: FcHistoryPoint[]
  followUps: FollowUpRow[]
  explainer: { generatedAt: string | null; attachRequestedAt: string | null; url: string; notes: ExplainerNote[] }
}) {
  const router = useRouter()
  const monthLabel = m.month.slice(0, 7)
  const monthEndIso = new Date(Date.UTC(+m.month.slice(0, 4), +m.month.slice(5, 7), 0)).toISOString().slice(0, 10)
  const [openInvoice, setOpenInvoice] = useState<string | null>(null)
  const [ledgerTab, setLedgerTab] = useState<"summary" | "items" | "tasks" | "visits" | "followups">("summary")
  const [genState, setGenState] = useState<"idle" | "working" | "done" | "error">("idle")
  const [genErr, setGenErr] = useState<string | null>(null)
  const [genAt, setGenAt] = useState<string | null>(explainer.generatedAt)
  const [attachAt, setAttachAt] = useState<string | null>(explainer.attachRequestedAt)
  const [noteDraft, setNoteDraft] = useState("")
  const [notes, setNotes] = useState(explainer.notes)
  const [letterFull, setLetterFull] = useState(false)
  const [thumbH, setThumbH] = useState<number | null>(null)
  // WRITE-AHEAD reviews: ids the user has marked, applied to the view
  // immediately — the POST and the server refresh catch up behind the click.
  const [aheadReviewed, setAheadReviewed] = useState<Set<number>>(new Set())
  const [reviewErr, setReviewErr] = useState<string | null>(null)
  void summaryNote

  // Flagged visits: the finding's message leads with the visit date.
  const dateOf = (f: MonthFinding) => f.message?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
  const openFindings = findings.filter((f) => !f.resolved_at && !aheadReviewed.has(f.id))
  const reviewedFindings = findings.filter((f) => f.resolved_at || aheadReviewed.has(f.id))
  const flaggedOpenDates = [...new Set(openFindings.map(dateOf).filter(Boolean))] as string[]
  const flaggedReviewedDates = [...new Set(reviewedFindings.map(dateOf).filter(Boolean))] as string[]

  const review = (ids: number[] | "all") => {
    const targets = ids === "all" ? openFindings.map((f) => f.id) : ids
    if (targets.length === 0) return
    setReviewErr(null)
    setAheadReviewed((prev) => new Set([...prev, ...targets]))
    fetch(`/api/billing/months/${m.id}/findings-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids === "all" ? { all: true } : { finding_ids: ids }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`))
        router.refresh()
      })
      .catch((e) => {
        // The write-ahead was wrong — put the rows back and say why.
        setAheadReviewed((prev) => {
          const next = new Set(prev)
          for (const id of targets) next.delete(id)
          return next
        })
        setReviewErr(`review failed: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`)
      })
  }
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | "loading" | "error" | null>(null)
  const [presentation, setPresentation] = useState<"itemized" | "summary" | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [draftEpoch, setDraftEpoch] = useState(0)
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
  }, [presentation, m.id, hasInvoices, draftEpoch])

  // RULED 2026-08-07: any billable item can be marked NON-BILLABLE — it
  // stays on the ledger but never reaches the invoice; task_id marks the
  // task's whole month.
  const toggleExclude = async (payload: { item_ids?: string[]; task_id?: string }, exclude: boolean) => {
    setActing("exclude")
    setActErr(null)
    try {
      const r = await fetch(`/api/billing/months/${m.id}/exclude-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, exclude }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(String(j.error ?? `HTTP ${r.status}`))
      setDraftEpoch((e) => e + 1)
      router.refresh()
    } catch (e) {
      setActErr(String(e instanceof Error ? e.message : e).slice(0, 140))
    } finally {
      setActing(null)
    }
  }

  // RULED 2026-08-07: the billing type is SET here (defaults to ION's
  // majority); whatever is selected when the invoice issues is what is used.
  const chooseDocSetting = async (dim: "consumables" | "presentation", value: string) => {
    setActing(`docset:${dim}`)
    setActErr(null)
    try {
      const r = await fetch(`/api/billing/months/${m.id}/doc-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [dim]: value }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(String(j.error ?? `HTTP ${r.status}`))
      setDraftEpoch((e) => e + 1)
      router.refresh()
    } catch (e) {
      setActErr(String(e instanceof Error ? e.message : e).slice(0, 140))
    } finally {
      setActing(null)
    }
  }

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
  const draftSettings = draft && draft !== "loading" && draft !== "error" ? draft.settings : undefined
  const separateConsumables = draftSettings
    ? draftSettings.consumables === "separate"
    : ledgerItems.some((i) => i.bucket === "consumables")
  const settingsConflicts = (draft && draft !== "loading" && draft !== "error" ? draft.settingsConflicts : undefined) ?? []

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
  ): { name: string; qty: number; rate: number; amount: number; date: string | null; visits: number; invoice: string | null; lineId: string | null; members: LedgerItem[] }[] => {
    if (lockedPresentation === "summary") {
      const g = new Map<string, { name: string; qty: number; rate: number; amount: number; date: null; visitSet: Set<string>; invoice: string | null; members: LedgerItem[] }>()
      for (const it of items) {
        // the group key includes the item's OWN invoice — items on different
        // documents never merge, so the linkage stays exact under grouping
        const key = `${it.item_name}|${it.unit_price_cents}|${it.qbo_invoice_id ?? "draft"}`
        const row = g.get(key) ?? { name: it.item_name ?? "—", qty: 0, rate: it.unit_price_cents / 100, amount: 0, date: null, visitSet: new Set<string>(), invoice: it.qbo_invoice_id, members: [] }
        row.qty += it.kind === "labor" ? 1 : Number(it.qty)
        row.amount += it.amount_cents / 100
        if (it.visit_id) row.visitSet.add(it.visit_id)
        row.members.push(it)
        g.set(key, row)
      }
      return [...g.values()]
        .map(({ visitSet, ...r }) => {
          const lineIds = [...new Set(r.members.map((mIt) => mIt.qbo_line_id).filter(Boolean))]
          return { ...r, visits: visitSet.size, lineId: lineIds.length === 1 ? (lineIds[0] as string) : null }
        })
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
      lineId: it.qbo_line_id,
      members: [it],
    }))
  }
  const excludedItems = ledgerItems.filter((i) => i.excluded_at)
  const activeItems = ledgerItems.filter((i) => !i.excluded_at)
  const laborItems = activeItems.filter((i) => i.kind === "labor" && i.amount_cents !== 0)
  const chemItems = activeItems.filter((i) => i.kind === "consumable")

  const actionBtn = "h-8 px-3 rounded-lg border border-line bg-bg-elev text-ink-dim text-[12px] font-medium hover:border-cyan hover:text-cyan disabled:opacity-50"
  const primaryBtn = "h-8 px-3.5 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        {/* ------------------------------- LEFT ------------------------------- */}
        <div className="space-y-4 min-w-0">
          {/* the BILLING MONTH summary strip — customer-card shaped */}
          <Card>
            <CardBody className="py-2.5 space-y-2">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="flex items-center gap-2 flex-none">
                  <span className="text-[13px] font-medium text-ink">Billing month · {monthLabel}</span>
                  {m.status === "disputed" && <Pill tone="coral">disputed</Pill>}
                  {isHeld(m) && <Pill tone="sun">held</Pill>}
                  <Pill tone={m.status === "closed" ? "grass" : "cyan"}>{m.status}</Pill>
                </span>
                <span className="flex items-center gap-4 font-mono text-[11px] ml-auto">
                  <span className="text-ink-mute">items <span className="text-ink num">{m.item_count}</span></span>
                  <span className="text-ink-mute">subtotal <span className="text-ink num">{formatCurrency(m.subtotal_cents / 100)}</span></span>
                  {hasInvoices && (
                    <>
                      <span className="text-ink-mute">invoiced <span className="text-ink num">{formatCurrency(fold.total)}</span></span>
                      <span className="text-ink-mute">
                        balance <span className={cn("num", fold.totalBalance > 0 ? "text-sun" : "text-grass")}>{formatCurrency(fold.totalBalance)}</span>
                      </span>
                    </>
                  )}
                </span>
                <span className="flex items-center gap-2 flex-none">
                  {/* THE one action (RULED 2026-08-05): a nudge onto the
                      advance queue — same depth-first path as the tick
                      (fresh gate verdict -> issue -> invoice machine).
                      Disabled with the reason; the command chain is the
                      only authority beyond that. Release hold retired —
                      reviewing the flags IS the release. */}
                  {!hasInvoices && m.status !== "disputed" && (() => {
                    const periodOpen = monthEndIso >= new Date().toISOString().slice(0, 10)
                    const blocked = openFindings.length > 0
                      ? `${openFindings.length} flagged visit${openFindings.length === 1 ? "" : "s"} await review`
                      : periodOpen
                        ? `the month isn't over until ${monthEndIso}`
                        : null
                    return (
                      <button
                        disabled={acting !== null || blocked !== null}
                        title={blocked ?? "advance this month: gate, issue, run the invoice machine"}
                        onClick={() => act("Issue invoices", "POST", `/api/billing/months/${m.id}/advance`)}
                        className={cn(primaryBtn, blocked && "opacity-50 cursor-not-allowed")}
                      >
                        {acting === "Issue invoices" ? "Issuing…" : "Issue invoices"}
                      </button>
                    )
                  })()}
                  {hasInvoices && m.status !== "closed" && (() => {
                    // The ladder ends at SEND: every invoice emailed means
                    // the machine is done — disable so nobody hunts for a
                    // step that doesn't exist (open balances await payment,
                    // not the machine).
                    const machineDone = (m.issued_invoices ?? []).every((i2) => i2.email_status === "EmailSent")
                    return (
                      <button
                        disabled={acting !== null || machineDone}
                        title={machineDone ? "machine done — every invoice emailed; open balances await payment" : "run each invoice's ladder: credit check, charge, send"}
                        onClick={() => act("Run machine", "POST", `/api/billing/months/${m.id}/machine`)}
                        className={cn(actionBtn, machineDone && "opacity-50 cursor-not-allowed")}
                      >
                        {acting === "Run machine" ? "Running…" : "Run machine"}
                      </button>
                    )
                  })()}
                </span>
              </div>
              <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(m.status)} />
              {((m.gate_held_for?.length ?? 0) > 0 || (m.disputes?.length ?? 0) > 0 || m.open_findings > 0 || actErr) && (
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
                  {actErr && <span className="text-[11px] text-coral">{actErr}</span>}
                </div>
              )}
            </CardBody>
          </Card>

          {/* the LEDGER tabs — page-level strip, ONE section on screen */}
          <div className="flex gap-1 border-b border-line-soft">
            {([
              ["summary", "Summary", openFindings.length, true],
              ["items", "Billable items", ledgerItems.length, false],
              ["visits", "Visits", visits.length, false],
              ["followups", "Follow-ups", followUps.length, false],
              ["tasks", "Tasks", monthTasks.length, false],
            ] as const).map(([key, label, count, hot]) => (
              <button
                key={key}
                onClick={() => setLedgerTab(key)}
                className={cn(
                  "px-3.5 py-2.5 text-[13px] -mb-px border-b-2",
                  ledgerTab === key ? "text-ink border-cyan font-medium" : "text-ink-mute border-transparent hover:text-ink",
                )}
              >
                {label}
                {count > 0 && (
                  <span
                    className={cn(
                      "ml-1.5 inline-flex items-center rounded-full px-1.5 text-[10px] font-mono align-[1px]",
                      hot ? "border border-coral/25 bg-coral/10 text-coral" : "border border-line bg-bg-elev text-ink-dim",
                    )}
                  >
                    {count}
                  </span>
                )}
                {key === "visits" && flaggedOpenDates.length > 0 && (
                  <span className="ml-1 inline-flex items-center rounded-full border border-coral/25 bg-coral/10 px-1.5 text-[10px] font-mono text-coral align-[1px]" title="flagged visits awaiting review">
                    {flaggedOpenDates.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          {ledgerTab === "summary" && (
            <>
              {/* the readings, in context: FULL FC history with the month
                  banded; the water-balance calendar stays month-scoped */}
              <Card>
                <CardHeader>
                  <CardTitle>Readings</CardTitle>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-mute">
                    {visits.length} visits
                    {flaggedOpenDates.length > 0 && <span className="text-coral"> · {flaggedOpenDates.length} flagged</span>}
                    {flaggedReviewedDates.length > 0 && <span className="text-sun"> · {flaggedReviewedDates.length} reviewed</span>}
                  </span>
                </CardHeader>
                <CardBody>
                  <ReadingsOverview
                    visits={visits}
                    period={{ start: `${monthLabel}-01`, end: monthEndIso }}
                    fcSlot={<FcHistoryChart points={fcHistory} monthStart={`${monthLabel}-01`} monthEnd={monthEndIso} />}
                  />
                </CardBody>
              </Card>

              {/* the pivot: readings + consumables sold x days serviced, with
                  the self / peer comparisons beside the totals */}
              <Card>
                <VisitCalendar
                  customerId={m.customer_id}
                  month={monthLabel}
                  highlightDates={[...flaggedOpenDates, ...flaggedReviewedDates]}
                  itemCompare={chemItemSummary}
                />
              </Card>

              {/* side by side: the flagged-visit review queue (the wider half —
                  it carries the readings grid) | the narrative + explainer */}
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
                <div className="space-y-0 lg:col-span-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-display text-[15px]">Flagged visits</span>
                    {openFindings.length > 0 && (
                      <button onClick={() => review("all")} className={actionBtn}>
                        Mark all reviewed ({openFindings.length})
                      </button>
                    )}
                  </div>
                  {reviewErr && <div className="text-[11px] text-coral mb-2">{reviewErr}</div>}
                  {flaggedOpenDates.length + flaggedReviewedDates.length === 0 ? (
                    <Card><CardBody><span className="text-[12.5px] text-ink-mute">No flagged visits this month.</span></CardBody></Card>
                  ) : (
                    <ServiceLog
                      visits={visits.filter((v) => {
                        const d = v.visit_date.slice(0, 10)
                        return flaggedOpenDates.includes(d) || flaggedReviewedDates.includes(d)
                      })}
                      flags={{ open: flaggedOpenDates, reviewed: flaggedReviewedDates }}
                      period={{ label: monthLabel, start: `${monthLabel}-01`, end: monthEndIso }}
                      compact
                      rowAction={(v) => {
                        const d = v.visit_date.slice(0, 10)
                        const ids = openFindings.filter((f) => dateOf(f) === d).map((f) => f.id)
                        if (ids.length === 0) {
                          // Resolved — the pill IS the resolution, whatever it was.
                          const res = reviewedFindings.find((f) => dateOf(f) === d)
                          if (!res) return null
                          return res.resolution === "skipped"
                            ? <Pill tone="neutral">skipped</Pill>
                            : <Pill tone="sun">{res.resolution ?? "reviewed"}</Pill>
                        }
                        return (
                          <button
                            onClick={() => review(ids)}
                            className="h-6 px-2 rounded-md border border-line bg-bg-elev text-[10.5px] text-ink-dim hover:border-sun hover:text-sun whitespace-nowrap"
                          >
                            Mark reviewed
                          </button>
                        )
                      }}
                    />
                  )}
                </div>

                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Explainer</CardTitle>
                    <span className="ml-auto flex items-center gap-3">
                      {/* ATTACH TOGGLE: freely switched until any invoice is
                          emailed, then frozen at its value. */}
                      {(() => {
                        const anySent = (m.issued_invoices ?? []).some((i2) => i2.email_status === "EmailSent")
                        return (
                          <button
                            role="switch"
                            aria-checked={!!attachAt}
                            disabled={anySent || acting === "attach" || (!attachAt && !explainer.generatedAt)}
                            title={anySent ? "invoices already emailed — the attach decision is frozen" : !attachAt && !explainer.generatedAt ? "generate the letter first" : attachAt ? "the send path will attach the letter — click to turn off" : "attach the letter when the invoices email"}
                            onClick={async () => {
                              const r = await fetch(`/api/billing/months/${m.id}/explainer-attach`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ attach: !attachAt }),
                              })
                              const j = await r.json()
                              if (r.ok) setAttachAt(attachAt ? null : new Date().toISOString())
                              else setGenErr(String(j.error ?? "attach failed").slice(0, 160))
                            }}
                            className={cn("flex items-center gap-2 text-[11.5px]", anySent ? "text-ink-mute cursor-not-allowed" : "text-ink-dim hover:text-ink")}
                          >
                            <span className={cn("relative inline-flex h-4 w-7 rounded-full transition-colors", attachAt ? "bg-teal-500/70" : "bg-line", anySent && "opacity-50")}>
                              <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all", attachAt ? "left-3.5" : "left-0.5")} />
                            </span>
                            Attach to invoices{anySent && " (locked)"}
                          </button>
                        )
                      })()}
                      <button
                        disabled={genState === "working"}
                        onClick={async () => {
                          setGenState("working")
                          setGenErr(null)
                          try {
                            const r = await fetch(`/api/billing/months/${m.id}/explainer-generate`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ note: noteDraft }),
                            })
                            const j = await r.json()
                            if (!r.ok) throw new Error(j.error ?? r.status)
                            setNotes(j.notes ?? notes)
                            setNoteDraft("")
                            setGenAt(new Date().toISOString())
                            setGenState("done")
                          } catch (e) {
                            setGenErr(String(e instanceof Error ? e.message : e).slice(0, 160))
                            setGenState("error")
                          }
                        }}
                        className={primaryBtn}
                        title="Save the note, send the log + the current letter to the model, replace the letter at its link"
                      >
                        {genState === "working" ? "Generating…" : genAt ? "Regenerate" : "Generate explainer"}
                      </button>
                    </span>
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {genAt ? (
                      <div className="relative border border-line-soft rounded-lg overflow-hidden">
                        <div className="absolute top-2 right-2 z-10 flex gap-1.5">
                          <button
                            onClick={() => setLetterFull(true)}
                            title="fullscreen"
                            className="h-7 w-7 rounded border border-line bg-bg-elev/90 text-ink-dim hover:text-ink text-[13px]"
                          >⤢</button>
                          <a
                            href={`${explainer.url}?download=1`}
                            title="download"
                            className="h-7 w-7 rounded border border-line bg-bg-elev/90 text-ink-dim hover:text-ink text-[13px] inline-flex items-center justify-center"
                          >⇩</a>
                        </div>
                        {/* A scaled-down THUMBNAIL of the whole page — no
                            scrollbars; fullscreen is the reading mode. The
                            width/scale pair (182% x 0.55) keeps the letter
                            fitted to the card at any width. */}
                        <div className="w-full overflow-hidden bg-white" style={thumbH ? { height: `${thumbH}px` } : { aspectRatio: "8.5 / 11" }}>
                          <iframe
                            key={genAt}
                            src={`${explainer.url}?thumb=1&t=${genAt}`}
                            title="Explainer letter"
                            className="pointer-events-none"
                            onLoad={(e) => {
                              // Same-origin: measure the letter's true height and
                              // size the box to EXACTLY the scaled content.
                              try {
                                const d = e.currentTarget.contentDocument
                                // Measure the PAGE element, not the document —
                                // the document stretches to the iframe's own
                                // oversized viewport and lies about content.
                                const page = d?.querySelector(".page")
                                const h = page ? page.getBoundingClientRect().height : d?.body.scrollHeight
                                if (h) setThumbH(Math.ceil(h * 0.55))
                              } catch { /* cross-origin never happens; keep aspect fallback */ }
                            }}
                            style={{ width: "182%", height: "182%", transform: "scale(0.55)", transformOrigin: "top left", border: "0" }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="text-[12px] text-ink-mute">No letter yet</div>
                    )}

                    {notes.length > 0 && (
                      <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
                        {notes.map((n, i2) => (
                          <div key={i2} className="flex items-start gap-2">
                            <span className="flex-none h-5 w-7 rounded bg-bg-elev border border-line text-[9px] font-mono text-ink-dim inline-flex items-center justify-center uppercase" title={n.by}>
                              {initialsOf(n.by)}
                            </span>
                            <div className="min-w-0">
                              <div className="text-[12px] text-ink leading-snug">{n.note}</div>
                              <div className="text-[10px] font-mono text-ink-mute">{new Date(n.at).toLocaleString()}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <textarea
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      rows={2}
                      placeholder="Add a note for the next generation — saved to the log when you hit Generate."
                      className="w-full bg-bg border border-line rounded-lg p-2.5 text-[12.5px] text-ink outline-none focus:border-cyan resize-y"
                    />
                    <div className="flex items-center gap-3 text-[11px]">
                      {genAt && <span className="text-ink-mute font-mono text-[10px]">generated {new Date(genAt).toLocaleString()}</span>}
                      {genErr && <span className="text-coral">{genErr}</span>}
                    </div>
                  </CardBody>
                </Card>
                {letterFull && (
                  <div className="fixed inset-0 z-50 bg-black/75 flex flex-col" onClick={() => setLetterFull(false)}>
                    <div className="flex justify-end p-3">
                      <button onClick={() => setLetterFull(false)} className="h-8 px-3 rounded border border-white/30 text-white/90 text-[13px] hover:bg-white/10">Close</button>
                    </div>
                    <iframe src={`${explainer.url}?t=${genAt ?? ""}`} title="Explainer letter — fullscreen" className="flex-1 bg-white mx-auto w-full max-w-[980px] mb-4 rounded-lg" onClick={(e) => e.stopPropagation()} />
                  </div>
                )}
              </div>
            </>
          )}

          {ledgerTab === "followups" && (
            <Card>
              <CardHeader>
                <CardTitle>Service follow-ups · {monthLabel}</CardTitle>
              </CardHeader>
              <CardBody>
                {followUps.length === 0 ? (
                  <div className="text-[12px] text-ink-mute">No follow-ups submitted for this customer this month.</div>
                ) : (
                  <div className="space-y-2.5">
                    {followUps.map((f) => (
                      <div key={f.id} className="border border-line-soft rounded-lg p-3 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12.5px] font-medium text-ink">{f.issue ?? "Follow-up"}</span>
                          {f.equipment_off && <Pill tone="coral">equipment off</Pill>}
                          {f.status && <Pill tone={f.status === "resolved" ? "grass" : "sun"}>{f.status}</Pill>}
                          <span className="ml-auto font-mono text-[10.5px] text-ink-mute">
                            {new Date(f.created_at).toLocaleDateString()} {f.source_tech_name ? `· ${f.source_tech_name}` : ""}
                          </span>
                        </div>
                        {f.description && <div className="text-[12px] text-ink-dim">{f.description}</div>}
                        {f.next_steps && <div className="text-[11.5px] text-ink-mute">Next: {f.next_steps}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {ledgerTab !== "visits" && ledgerTab !== "summary" && ledgerTab !== "followups" && (
          <Card>
            {ledgerTab === "items" && (
              <CardHeader>
                <CardTitle>Billable items</CardTitle>
                <span
                  className="ml-auto flex items-center gap-1.5"
                  title={hasInvoices ? "The documents inherited these settings — locked" : "Defaults to ION's task config; click to set the month's billing type (RULED: the selection here is what the issue uses)"}
                >
                  <span className={`flex border border-line rounded-lg overflow-hidden ${hasInvoices ? "opacity-70" : ""}`}>
                    {(["itemized", "summary"] as const).map((p2, i2) => (
                      <button
                        key={p2}
                        disabled={hasInvoices || acting !== null}
                        onClick={() => chooseDocSetting("presentation", p2)}
                        className={`h-[22px] px-2 text-[10.5px] font-semibold leading-[22px] ${i2 === 1 ? "border-l border-line" : ""} ${lockedPresentation === p2 ? "bg-cyan text-bg" : "text-ink-dim hover:text-ink"} disabled:cursor-default`}
                      >
                        {p2 === "itemized" ? "Itemized" : "Summary"}
                      </button>
                    ))}
                  </span>
                  <span className={`flex border border-line rounded-lg overflow-hidden ${hasInvoices ? "opacity-70" : ""}`}>
                    {(["included", "separate"] as const).map((c2, i2) => (
                      <button
                        key={c2}
                        disabled={hasInvoices || acting !== null}
                        onClick={() => chooseDocSetting("consumables", c2)}
                        className={`h-[22px] px-2 text-[10.5px] font-semibold leading-[22px] ${i2 === 1 ? "border-l border-line" : ""} ${(separateConsumables ? "separate" : "included") === c2 ? "bg-cyan text-bg" : "text-ink-dim hover:text-ink"} disabled:cursor-default`}
                      >
                        {c2 === "included" ? "Chems included" : "Chems separate"}
                      </button>
                    ))}
                  </span>
                  {settingsConflicts.length > 0 && <Pill tone="coral">ION tasks disagree — flagged</Pill>}
                </span>
              </CardHeader>
            )}
            {ledgerTab === "tasks" && (monthTasks.length === 0 ? (
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
                    <TableHead className="text-right">Billing</TableHead>
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
                      <TableCell className="text-right">
                        {hasInvoices ? (
                          <span className="text-[10px] text-ink-mute">locked</span>
                        ) : excludedItems.some((i) => i.task_id === t.task_id) ? (
                          <button
                            onClick={() => toggleExclude({ task_id: t.task_id }, false)}
                            disabled={acting !== null}
                            className="text-[10.5px] text-ink-mute hover:text-ink underline underline-offset-2 disabled:opacity-40"
                          >
                            restore month
                          </button>
                        ) : (
                          <button
                            onClick={() => toggleExclude({ task_id: t.task_id }, true)}
                            disabled={acting !== null}
                            title="mark ALL this task's items for the month non-billable"
                            className="text-[10.5px] text-ink-mute hover:text-coral underline underline-offset-2 disabled:opacity-40"
                          >
                            mark month non-billable
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
            {ledgerTab === "items" && lockedPresentation === "itemized" && ledgerItems.length > 0 && (
              // ITEMIZED reads like the invoice will: grouped by VISIT,
              // labor first, then the consumables that went in that day.
              (() => {
                // ALL claimed items — including $0 labor (quality control):
                // the line documents the visit even when it bills nothing.
                const shown = activeItems.filter((i) => i.kind === "labor" || i.kind === "consumable")
                // A FLAT-RATE labor line belongs to the month, not a visit —
                // it gets its own group instead of hiding inside a date.
                const flatLines = shown.filter((i) => i.kind === "labor" && i.visit_id === null)
                const flatTaskIds = new Set(flatLines.map((i) => i.task_id).filter(Boolean))
                const flatVisitLabor = shown.filter((i) => i.kind === "labor" && i.visit_id !== null && i.amount_cents === 0 && i.task_id && flatTaskIds.has(i.task_id))
                const inDropdown = new Set(flatVisitLabor.map((i) => i.id))
                const visitLines = shown.filter((i) => !(i.kind === "labor" && i.visit_id === null) && !inDropdown.has(i.id))
                const byDate = new Map<string, LedgerItem[]>()
                for (const it of visitLines) {
                  const d = (it.service_date ?? "").slice(0, 10) || "no date"
                  byDate.set(d, [...(byDate.get(d) ?? []), it])
                }
                const dates = [...byDate.keys()].sort()
                const monthTotal = shown.reduce((s2, i) => s2 + i.amount_cents, 0)
                const dateGroups = dates.map((d) => {
                  const items = (byDate.get(d) ?? []).sort((a, b) =>
                    a.kind === b.kind ? (a.item_name ?? "").localeCompare(b.item_name ?? "") : a.kind === "labor" ? -1 : 1,
                  )
                  const daySubtotal = items.reduce((s2, i) => s2 + i.amount_cents, 0)
                  return (
                    <div key={d} className="border-t border-line-soft first:border-t-0">
                      <div className="flex items-center gap-2 px-5 py-1.5 bg-white/[0.015]">
                        <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">
                          {d === "no date" ? "No visit date" : visitBreakLabel(d)}
                        </span>
                        <span className="ml-auto font-mono num text-[11px] text-ink-dim">{formatCurrency(daySubtotal / 100)}</span>
                      </div>
                      {items.map((it, i) => {
                        const invDoc = it.qbo_invoice_id ? invoices.find((iv) => iv.qbo_invoice_id === it.qbo_invoice_id) : null
                        return (
                          <div key={i} className="flex items-center gap-2.5 px-5 py-1 border-t border-line-soft/50">
                            <span className={cn("w-[10px] flex-none rounded-full h-[5px]", it.kind === "labor" ? "bg-cyan/50" : "bg-sun/50")} title={it.kind} />
                            <span className="text-[11.5px] text-ink flex-1 min-w-0 truncate">{it.item_name ?? "—"}</span>
                            <span className="font-mono text-[10px] text-ink-mute flex-none">
                              {it.qty} × {formatCurrency(it.unit_price_cents / 100)}
                            </span>
                            <span className="w-[70px] flex-none text-right">
                              {it.qbo_invoice_id ? (
                                <button
                                  onClick={() => setOpenInvoice(it.qbo_invoice_id!)}
                                  className="font-mono text-[9.5px] text-ink-mute hover:text-cyan underline underline-offset-2"
                                >
                                  {invDoc?.doc_number ?? it.qbo_invoice_id}
                                </button>
                              ) : (
                                <span className="font-mono text-[9.5px] text-ink-mute/50">draft</span>
                              )}
                            </span>
                            <span className="font-mono num text-[11.5px] text-ink w-[70px] text-right flex-none">{formatCurrency(it.amount_cents / 100)}</span>
                            {!hasInvoices && (
                              <button
                                onClick={() => toggleExclude({ item_ids: [it.id] }, true)}
                                disabled={acting !== null}
                                title="mark non-billable — stays on the ledger, never reaches the invoice"
                                className="flex-none font-mono text-[11px] text-ink-mute hover:text-coral disabled:opacity-40"
                              >
                                ⊘
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })
                return (
                  <>
                    {flatLines.length > 0 && (
                      <div className="border-t border-line-soft first:border-t-0">
                        <div className="flex items-center gap-2 px-5 py-1.5 bg-white/[0.015]">
                          <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">Monthly flat rate</span>
                          <span className="ml-auto font-mono num text-[11px] text-ink-dim">
                            {formatCurrency(flatLines.reduce((s2, i) => s2 + i.amount_cents, 0) / 100)}
                          </span>
                        </div>
                        {flatLines.map((it, i) => {
                          const visitsIn = flatVisitLabor.filter((v) => v.task_id === it.task_id)
                          const gk = `flat|${it.task_id}`
                          const open = openGroups.has(gk)
                          return (
                            <div key={i} className="border-t border-line-soft/50">
                              <div
                                onClick={() => {
                                  if (visitsIn.length === 0) return
                                  const next = new Set(openGroups)
                                  if (open) next.delete(gk)
                                  else next.add(gk)
                                  setOpenGroups(next)
                                }}
                                className={cn("flex items-center gap-2.5 px-5 py-1", visitsIn.length > 0 && "cursor-pointer hover:bg-white/[0.02]")}
                              >
                                <span className="w-[10px] flex-none font-mono text-[9px] text-ink-mute">{visitsIn.length > 0 ? (open ? "▾" : "▸") : ""}</span>
                                <span className="text-[11.5px] text-ink flex-1 min-w-0 truncate">{it.item_name ?? "—"}</span>
                                <span className="font-mono text-[9.5px] text-ink-mute flex-none">{visitsIn.length > 0 ? `${visitsIn.length} visit${visitsIn.length === 1 ? "" : "s"}` : ""}</span>
                                <span className="font-mono text-[10px] text-ink-mute flex-none">
                                  {it.qty} × {formatCurrency(it.unit_price_cents / 100)}
                                </span>
                                <span className="font-mono num text-[11.5px] text-ink w-[70px] text-right flex-none">{formatCurrency(it.amount_cents / 100)}</span>
                                {!hasInvoices && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleExclude({ item_ids: [it.id] }, true) }}
                                    disabled={acting !== null}
                                    title="mark non-billable — stays on the ledger, never reaches the invoice"
                                    className="flex-none font-mono text-[11px] text-ink-mute hover:text-coral disabled:opacity-40"
                                  >
                                    ⊘
                                  </button>
                                )}
                              </div>
                              {open &&
                                visitsIn
                                  .slice()
                                  .sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)))
                                  .map((v, vi) => (
                                    <div key={vi} className="flex items-center gap-2.5 pl-10 pr-5 py-[3px] bg-white/[0.012]">
                                      <span className="font-mono text-[9.5px] text-ink-mute flex-none w-[64px]">{(v.service_date ?? "").slice(0, 10)}</span>
                                      <span className="text-[10.5px] text-ink-dim flex-1 min-w-0 truncate">{v.item_name ?? "—"}</span>
                                      <span className="font-mono text-[10px] text-ink-mute flex-none">folds into the monthly line</span>
                                    </div>
                                  ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {dateGroups}
                    <div className="flex items-baseline justify-between border-t border-line px-5 py-2.5">
                      <span className="text-[12px] font-medium text-ink">Total</span>
                      <span className="font-display text-[17px] text-ink">{formatCurrency(monthTotal / 100)}</span>
                    </div>
                  </>
                )
              })()
            )}
            {ledgerTab === "items" && (lockedPresentation !== "itemized" || ledgerItems.length === 0) && (ledgerItems.length === 0 ? (
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
                      <span className="ml-auto font-mono num text-[11px] text-ink-dim">{formatCurrency(subtotal / 100)}</span>
                    </div>
                    {rows.map((r, i) => {
                      const invDoc = r.invoice ? invoices.find((iv) => iv.qbo_invoice_id === r.invoice) : null
                      const groupKey = `${key}|${r.name}|${r.rate}|${r.invoice ?? "draft"}`
                      const expandable = r.members.length > 1
                      const open = openGroups.has(groupKey)
                      return (
                        <div key={i} className="border-t border-line-soft/50">
                          <div
                            onClick={() => {
                              if (!expandable) return
                              const next = new Set(openGroups)
                              if (open) next.delete(groupKey)
                              else next.add(groupKey)
                              setOpenGroups(next)
                            }}
                            className={cn("flex items-center gap-2.5 px-5 py-1", expandable && "cursor-pointer hover:bg-white/[0.02]")}
                          >
                            <span className="w-[10px] flex-none font-mono text-[9px] text-ink-mute">
                              {expandable ? (open ? "▾" : "▸") : ""}
                            </span>
                            <span className="text-[11.5px] text-ink flex-1 min-w-0 truncate">{r.name}</span>
                            <span className="font-mono text-[9.5px] text-ink-mute flex-none w-[64px]">
                              {r.date ?? `${r.visits} visit${r.visits === 1 ? "" : "s"}`}
                            </span>
                            <span className="font-mono text-[10px] text-ink-mute flex-none">
                              {r.qty} × {formatCurrency(r.rate)}
                            </span>
                            <span className="w-[52px] flex-none text-right font-mono text-[9.5px] text-ink-mute" title="QBO line id">
                              {r.lineId ? `ln ${r.lineId}` : "—"}
                            </span>
                            <span className="w-[70px] flex-none text-right">
                              {r.invoice ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setOpenInvoice(r.invoice!)
                                  }}
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
                          {open &&
                            r.members
                              .slice()
                              .sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)))
                              .map((mIt, mi) => (
                                <div key={mi} className="flex items-center gap-2.5 pl-10 pr-5 py-[3px] bg-white/[0.012]">
                                  <button
                                    onClick={() => setLedgerTab("visits")}
                                    className="font-mono text-[9.5px] text-ink-dim hover:text-cyan underline underline-offset-2 flex-none"
                                    title="Open the visit log"
                                  >
                                    {mIt.service_date
                                      ? new Date(mIt.service_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
                                      : "no visit"}
                                  </button>
                                  <span className="font-mono text-[9px] text-ink-mute flex-none">
                                    {Number(mIt.qty)} × {formatCurrency(mIt.unit_price_cents / 100)}
                                  </span>
                                  <span className="ml-auto font-mono num text-[10.5px] text-ink-dim flex-none">
                                    {formatCurrency(mIt.amount_cents / 100)}
                                  </span>
                                </div>
                              ))}
                        </div>
                      )
                    })}
                  </div>
                )
              }).concat(
                <div key="total" className="flex items-center gap-2 px-5 py-2 border-t border-line">
                  <span className="text-[12px] font-medium text-ink">Total</span>
                  <span className="ml-auto font-mono num text-[12.5px] font-semibold text-ink">
                    {formatCurrency(activeItems.reduce((s2, i) => s2 + i.amount_cents, 0) / 100)}
                  </span>
                </div>,
              )
            ))}
            {ledgerTab === "items" && excludedItems.length > 0 && (
              <div className="border-t border-line">
                <div className="flex items-center gap-2 px-5 py-1.5 bg-coral/[0.04]">
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-coral/80">Non-billable</span>
                  <span className="text-[10px] text-ink-mute">on the ledger, never on the invoice</span>
                  <span className="ml-auto font-mono num text-[11px] text-ink-mute line-through">
                    {formatCurrency(excludedItems.reduce((s2, i) => s2 + i.amount_cents, 0) / 100)}
                  </span>
                </div>
                {excludedItems.map((it, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-5 py-1 border-t border-line-soft/50 opacity-60">
                    <span className={cn("w-[10px] flex-none rounded-full h-[5px]", it.kind === "labor" ? "bg-cyan/40" : "bg-sun/40")} />
                    <span className="text-[11.5px] text-ink-dim flex-1 min-w-0 truncate">{it.item_name ?? "—"}</span>
                    <span className="font-mono text-[9.5px] text-ink-mute flex-none w-[64px]">{(it.service_date ?? "").slice(0, 10) || "—"}</span>
                    <span className="font-mono text-[10px] text-ink-mute flex-none">
                      {it.qty} × {formatCurrency(it.unit_price_cents / 100)}
                    </span>
                    <span className="font-mono num text-[11.5px] text-ink-mute line-through w-[70px] text-right flex-none">{formatCurrency(it.amount_cents / 100)}</span>
                    {!hasInvoices && (
                      <button
                        onClick={() => toggleExclude({ item_ids: [it.id] }, false)}
                        disabled={acting !== null}
                        className="flex-none text-[10px] text-ink-mute hover:text-ink underline underline-offset-2 disabled:opacity-40"
                      >
                        restore
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          )}

          {/* the LOGS — the Visits tab */}
          {ledgerTab === "visits" && (
            <ServiceLog
              visits={visits}
              flags={{ open: flaggedOpenDates, reviewed: flaggedReviewedDates }}
              period={{
                label: monthLabel,
                start: `${monthLabel}-01`,
                end: new Date(Date.UTC(+monthLabel.slice(0, 4), +monthLabel.slice(5, 7), 0)).toISOString().slice(0, 10),
              }}
            />
          )}
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
