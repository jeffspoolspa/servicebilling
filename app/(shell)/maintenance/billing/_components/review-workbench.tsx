"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { formatCurrency } from "@/lib/utils/format"
import { ServiceLog, type ServiceLogVisit } from "../../_components/service-log"

/**
 * Bill-review workbench — first draft of Carter's design 2a ("Remix"):
 * narrow invoice ledger (per-line usage vs the customer's usual month, inline
 * $/%/comp adjustments with required reason) + service-log evidence rail
 * (expandable visit rows: readings, chems sold, notes, PHOTOS) + AI analysis
 * placeholder. Data is all real; adjustments are DRAFT-ONLY (local state, not
 * written to QBO yet). Photos: public S3 thumbs, click-through to full size
 * via /api/maintenance-billing/photo (ProEdge signed URL).
 */

export interface WorkbenchInvoice {
  qbo_invoice_id: string
  doc_number: string | null
  txn_date: string | null
  total_amt: number | null
  balance: number | null
  email_status: string | null
  line_items:
    | { line_type?: string; item_name?: string | null; description?: string | null
        qty?: number | null; unit_price?: number | null; amount?: number | null }[]
    | null
}

export type WorkbenchVisit = ServiceLogVisit

export interface BillAnalysis {
  result: { driver?: string; normal?: string; recommend?: string }
  model: string | null
  created_at: string
}

export interface WatchEntry {
  id: number
  reason: string
  reason_label: string
  priority: number
  source: string
  rule_key: string | null
  note: string | null
  opened_at: string
}

export interface FlagContext {
  peerGroup: string | null
  peerMedian: number | null
  peerN: number | null
  history: { month: string; chem_usd: number; visits: number }[]
}

export interface UsualItem {
  item_name: string
  month_qty: number | null
  month_usd: number | null
  usual_qty: number | null
  usual_usd: number | null
}

interface Adjustment {
  value: number // dollars off
  label: string
  reason: string
  item: string
}





// canonical season buckets (matches billing_audit.v_customer_month_cpv):
// summer May-Aug, shoulder (fall/spring) Mar-Apr + Sep-Oct, winter Nov-Feb
function seasonOf(month: string): "summer" | "shoulder" | "winter" {
  const m = parseInt(month.slice(5, 7), 10)
  if (m >= 5 && m <= 8) return "summer"
  if (m === 3 || m === 4 || m === 9 || m === 10) return "shoulder"
  return "winter"
}
const SEASON_LABEL = { summer: "summer", shoulder: "fall/spring", winter: "winter" } as const

function bare(name: string | null | undefined): string {
  if (!name) return "—"
  return name.split(":").pop()!.trim()
}

// quantities: integer when whole, else one decimal (2 -> "2", 2.5 -> "2.5")
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function ReviewWorkbench({
  customerId,
  qboCustomerId,
  customerName,
  month, // 'YYYY-MM'
  monthLabel,
  reasons,
  notes,
  periodIds,
  invoices,
  visits,
  usual,
  initialAnalysis = null,
  queue = [],
  flagContext = null,
  watchlist = [],
}: {
  customerId: number
  qboCustomerId: string
  customerName: string
  month: string
  monthLabel: string
  reasons: string[]
  notes: string[]
  periodIds: string[]
  invoices: WorkbenchInvoice[]
  visits: WorkbenchVisit[]
  usual: UsualItem[]
  initialAnalysis: BillAnalysis | null
  queue: { customerId: number; name: string }[]
  flagContext: FlagContext | null
  watchlist: WatchEntry[]
}) {
  const router = useRouter()
  const [adjustments, setAdjustments] = useState<Record<string, Adjustment>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [mode, setMode] = useState<"$" | "%" | "comp">("$")
  const [amt, setAmt] = useState("")
  const [reason, setReason] = useState("")
  const [err, setErr] = useState("")
  const [releasing, setReleasing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyState, setApplyState] = useState("")
  const [analysis, setAnalysis] = useState<BillAnalysis | null>(initialAnalysis)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisErr, setAnalysisErr] = useState("")
  const [watch, setWatch] = useState<WatchEntry[]>(watchlist)
  const [watchOpen, setWatchOpen] = useState(false)
  const [watchReason, setWatchReason] = useState("watch")
  const [watchPriority, setWatchPriority] = useState(3)
  const [watchNote, setWatchNote] = useState("")
  const [watchBusy, setWatchBusy] = useState(false)

  async function addWatch() {
    setWatchBusy(true)
    try {
      const r = await fetch("/api/maintenance-billing/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add", period_ids: periodIds, reason: watchReason,
          priority: watchPriority, note: watchNote.trim() || null,
        }),
      })
      if (r.ok) {
        setWatchOpen(false)
        setWatchNote("")
        router.refresh()
      }
    } finally {
      setWatchBusy(false)
    }
  }

  async function resolveWatch(id: number) {
    const r = await fetch("/api/maintenance-billing/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve", id, note: "Resolved from bill review" }),
    })
    if (r.ok) {
      setWatch(watch.filter((w) => w.id !== id))
      router.refresh()
    }
  }

  useEffect(() => setWatch(watchlist), [watchlist])


  const usualByItem = useMemo(() => {
    const m = new Map<string, UsualItem>()
    for (const u of usual) m.set(u.item_name.toUpperCase(), u)
    return m
  }, [usual])

  // invoice lines GROUPED by product per invoice: ION sometimes emits one
  // line per dose (3x "MURIATIC ACID 1GAL" qty 1) — the ledger shows the
  // rollup (qty and $ summed). key = invoiceId:product so adjustments apply
  // to the group (the discount lands as its own QBO line either way).
  const lines = useMemo(() => {
    const out = new Map<string, {
      key: string; invoice: WorkbenchInvoice; name: string; detail: string
      amount: number; usual: UsualItem | undefined
      qty: number | null; rates: Set<number>; lineCount: number
    }>()
    for (const inv of invoices) {
      for (const li of inv.line_items ?? []) {
        if (li.line_type && li.line_type !== "item") continue
        const amount = Number(li.amount ?? 0)
        const name = bare(li.item_name)
        const qty = li.qty != null ? Number(li.qty) : null
        const rate = li.unit_price != null ? Number(li.unit_price) : null
        const key = `${inv.qbo_invoice_id}:${name.toUpperCase()}`
        const g = out.get(key)
        if (g) {
          g.amount += amount
          g.qty = g.qty != null && qty != null ? g.qty + qty : null
          if (rate != null) g.rates.add(rate)
          g.lineCount++
        } else {
          out.set(key, {
            key, invoice: inv, name, amount,
            qty, rates: new Set(rate != null ? [rate] : []), lineCount: 1,
            detail: "",
            usual: usualByItem.get(name.toUpperCase()),
          })
        }
      }
    }
    return [...out.values()].map((g) => ({
      ...g,
      detail: g.qty != null && g.rates.size === 1
        ? `${g.qty} × ${formatCurrency([...g.rates][0])}${g.lineCount > 1 ? ` · ${g.lineCount} lines` : ""}`
        : g.qty != null
          ? `${g.qty} across ${g.lineCount} lines`
          : "",
    }))
  }, [invoices, usualByItem])

  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const discTotal = Object.values(adjustments).reduce((s, a) => s + a.value, 0)
  const total = subtotal - discTotal
  const totalDue = invoices.reduce((s, i) => s + Number(i.balance ?? 0), 0)

  const queueIdx = queue.findIndex((q) => q.customerId === customerId)
  const nextInQueue = queueIdx >= 0 ? queue[queueIdx + 1] ?? null : null
  const prevInQueue = queueIdx > 0 ? queue[queueIdx - 1] : null
  const billHref = (id: number) => `/maintenance/billing/review/${id}/bill?month=${month}`
  const draftCount = Object.keys(adjustments).length

  function openEditor(key: string) {
    setEditing(key); setMode("$"); setAmt(""); setReason(""); setErr("")
  }

  function applyAdjustment(line: { key: string; amount: number; name: string }) {
    let value = 0
    if (mode === "comp") value = line.amount
    else {
      const v = parseFloat(amt)
      if (!isFinite(v) || v <= 0) { setErr("Enter an amount (or Comp)."); return }
      value = mode === "$" ? Math.min(v, line.amount) : Math.min((line.amount * v) / 100, line.amount)
    }
    if (!reason.trim()) { setErr("A reason is required."); return }
    const label = mode === "comp" ? "Comped"
      : mode === "%" ? `−${parseFloat(amt)}% · −${formatCurrency(value)}`
      : `−${formatCurrency(value)}`
    setAdjustments({ ...adjustments, [line.key]: { value, label, reason: reason.trim(), item: line.name } })
    setEditing(null)
  }

  async function pollJob(pollUrl: string, timeoutMs = 180000): Promise<any> {
    const t0 = Date.now()
    for (;;) {
      const r = await fetch(pollUrl)
      const j = await r.json()
      if (j.completed) {
        if (j.success === false || j.result?.error) throw new Error(j.result?.error?.message ?? "job failed")
        return j.result
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for QBO write")
      await new Promise((res) => setTimeout(res, 2000))
    }
  }

  // Apply Discounts = write draft adjustments to QBO (one batch per invoice)
  // and refresh the cache. SEPARATE from Approve — the refreshed invoice comes
  // back with the DISCOUNT lines and updated total.
  async function applyDiscounts() {
    setApplying(true)
    setApplyState("")
    try {
      const byInvoice = new Map<string, { item_name: string; amount: number; reason: string }[]>()
      for (const [key, adj] of Object.entries(adjustments)) {
        const invoiceId = key.split(":")[0]
        const arr = byInvoice.get(invoiceId) ?? []
        arr.push({ item_name: adj.item, amount: Math.round(adj.value * 100) / 100, reason: adj.reason })
        byInvoice.set(invoiceId, arr)
      }
      let n = 0
      for (const [qbo_invoice_id, adjs] of byInvoice) {
        n += adjs.length
        setApplyState(`Applying ${n} to QBO…`)
        const r = await fetch("/api/maintenance-billing/adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qbo_invoice_id, adjustments: adjs }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? "adjustment trigger failed")
        await pollJob(`/api/maintenance-billing/adjustments?job=${j.jobId}`)
      }
      setAdjustments({})
      setApplyState("")
      router.refresh()
    } catch (e) {
      setApplyState(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  // Approve = release to ready_to_process only. Pending discounts block it
  // (apply or remove them first) so nothing is lost.
  async function release() {
    setReleasing(true)
    try {
      // a chem_flag hold only releases once the flag itself is marked
      // reviewed (customer_month_audit) — reviewed_at alone gets re-held by
      // the projection. Approve = the review, so record it.
      if (reasons.includes("chem_flag")) {
        const fr = await fetch("/api/maintenance-billing/flags/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id: customerId,
            month: `${month}-01`,
            status: "reviewed",
            note: "Approved via bill review workbench",
          }),
        })
        // 404 = no flag row (already released elsewhere) — fine to continue
        if (!fr.ok && fr.status !== 404) throw new Error("flag release failed")
      }
      const r = await fetch("/api/maintenance-billing/periods/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: periodIds, status: "ready_to_process" }),
      })
      if (!r.ok) throw new Error("release failed")
      router.push(
        (nextInQueue ? billHref(nextInQueue.customerId) : `/maintenance/billing/review?month=${month}`) as never,
      )
    } catch (e) {
      setApplyState(`Failed: ${e instanceof Error ? e.message : String(e)}`)
      setReleasing(false)
    }
  }

  async function analyze() {
    setAnalyzing(true)
    setAnalysisErr("")
    try {
      const r = await fetch("/api/maintenance-billing/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, qbo_customer_id: qboCustomerId, month }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "analysis trigger failed")
      const result = await pollJob(`/api/maintenance-billing/analyze?job=${j.jobId}`, 120000)
      setAnalysis({ result: result.result, model: null, created_at: new Date().toISOString() })
    } catch (e) {
      setAnalysisErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalyzing(false)
    }
  }




  const seg = (on: boolean) =>
    on ? "bg-cyan text-bg" : "bg-transparent text-ink-dim"

  return (
    <div className="rounded-xl border border-line bg-bg-surface overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-line-soft flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-[17px] tracking-tight">{customerName}</span>
          <span className="font-mono text-[10.5px] text-ink-mute">
            {invoices.map((i) => `Inv ${i.doc_number ?? i.qbo_invoice_id}`).join(" · ")} · {monthLabel}
          </span>
          {reasons.map((r) => (
            <span key={r}
              className="text-[10px] uppercase tracking-[0.08em] text-sun bg-sun/10 border border-sun/30 rounded-full px-2 py-0.5">
              {r.replaceAll("_", " ")}
            </span>
          ))}
          {invoices.some((i) => i.email_status === "EmailSent") ? (
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-bg-elev border border-line rounded-full px-2 py-0.5">Sent</span>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-bg-elev border border-line rounded-full px-2 py-0.5">Not sent</span>
          )}
          {watch.map((w) => (
            <span
              key={w.id}
              title={`${w.source === "rule" ? `rule: ${w.rule_key} · ` : ""}${w.note ?? ""} · since ${new Date(w.opened_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`}
              className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] rounded-full px-2 py-0.5 border ${
                w.priority === 1 ? "text-coral bg-coral/10 border-coral/30" : "text-sun bg-sun/10 border-sun/30"
              }`}
            >
              {w.reason_label}{w.priority === 1 && " · critical"}
              <button
                onClick={() => resolveWatch(w.id)}
                title="Concern handled — back to good"
                className="hover:text-grass"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="flex-1" />
        {queueIdx >= 0 && queue.length > 1 && (
          <div className="flex items-center gap-1.5 mr-2">
            <button
              onClick={() => prevInQueue && router.push(billHref(prevInQueue.customerId) as never)}
              disabled={!prevInQueue}
              title={prevInQueue ? `Previous: ${prevInQueue.name}` : undefined}
              className="h-7 w-7 rounded-lg border border-line bg-bg-elev text-ink-dim text-[13px] hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-dim"
              aria-label="Previous held bill"
            >
              ‹
            </button>
            <span className="font-mono text-[10.5px] text-ink-mute whitespace-nowrap">
              {queueIdx + 1} of {queue.length} held
            </span>
            <button
              onClick={() => nextInQueue && router.push(billHref(nextInQueue.customerId) as never)}
              disabled={!nextInQueue}
              title={nextInQueue ? `Next: ${nextInQueue.name}` : undefined}
              className="h-7 w-7 rounded-lg border border-line bg-bg-elev text-ink-dim text-[13px] hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-dim"
              aria-label="Next held bill"
            >
              ›
            </button>
          </div>
        )}
        <div className="text-right mr-1.5">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">Total due</div>
          <div className="font-display text-[19px] text-sun">{formatCurrency(totalDue)}</div>
        </div>
        <button
          onClick={() => setWatchOpen(true)}
          className="h-8 px-3 rounded-lg border border-line bg-bg-elev text-ink-dim text-[12px] font-medium hover:border-sun hover:text-sun"
        >
          Add To Watchlist
        </button>
        <button
          onClick={release}
          disabled={releasing || draftCount > 0}
          title={draftCount > 0 ? "Apply or remove the pending discounts first" : undefined}
          className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"
        >
          {releasing ? "Releasing…" : "Approve"}
        </button>
        {!releasing && applyState.startsWith("Failed") && (
          <span className="text-[11px] text-coral max-w-[260px]">{applyState}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[430px_1fr] lg:h-[680px]">
        {/* LEFT: invoice ledger */}
        <div className="border-r border-line-soft pt-2 overflow-y-auto min-h-0">
          <div className="flex items-center justify-between px-5 py-2">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">
              Invoice lines
            </span>
            {draftCount > 0 && (
              <span className="inline-flex items-center gap-2">
                <span className="font-mono text-[10px] text-coral">
                  {draftCount} pending · −{formatCurrency(discTotal)}
                </span>
                <button
                  onClick={applyDiscounts}
                  disabled={applying}
                  title="Writes DISCOUNT lines to the QBO invoice and refreshes the cache"
                  className="h-6 px-2.5 rounded-md bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[11px] font-semibold hover:brightness-110 disabled:opacity-50"
                >
                  {applying ? applyState || "Applying…" : "Apply Discounts"}
                </button>
              </span>
            )}
          </div>
          {applyState.startsWith("Failed") && !applying && (
            <div className="px-5 pb-1 text-[11px] text-coral">{applyState}</div>
          )}
          {lines.length === 0 && (
            <div className="px-5 py-8 text-center text-[12px] text-ink-mute">
              No line items on the linked invoice{invoices.length === 1 ? "" : "s"}.
            </div>
          )}
          {lines.map((ln) => {
            const adj = adjustments[ln.key]
            const u = ln.usual
            // quantity vs the customer's usual-month quantity
            const qtyNow = u?.month_qty != null ? Number(u.month_qty) : null
            const qtyAvg = u?.usual_qty != null ? Number(u.usual_qty) : null
            const ratio = qtyNow != null && qtyAvg != null && qtyAvg > 0 ? qtyNow / qtyAvg : null
            const ratioColor = ratio == null ? "text-ink-mute"
              : ratio <= 1.2 && ratio >= 0.85 ? "text-ink-mute"
              : ratio > 1.6 ? "text-coral"   // well over usual
              : ratio > 1.2 ? "text-sun"     // over usual
              : "text-cyan"                   // under usual
            return (
              <div key={ln.key} className="border-b border-line-soft px-5 py-2.5 hover:bg-white/[0.015]">
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-ink">{ln.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-mute mt-0.5 flex items-baseline gap-2">
                      <span>
                        {ln.detail}
                        {invoices.length > 1 && <span> · #{ln.invoice.doc_number}</span>}
                      </span>
                      {ratio != null && (ratio >= 1.15 || ratio <= 0.85) && (
                        <span className={`group relative whitespace-nowrap cursor-default ${ratioColor}`}>
                          {ratio >= 1 ? "▲" : "▼"} {fmtQty(Math.abs(qtyNow! - qtyAvg!))} vs avg
                          <span className="pointer-events-none absolute left-0 top-full mt-1 z-10 hidden group-hover:block whitespace-nowrap rounded-md border border-line bg-bg px-2 py-1 text-[10px] text-ink-dim shadow-card">
                            {fmtQty(qtyNow!)} this month · avg {qtyAvg!.toFixed(1)}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="w-[92px] text-right flex-none">
                    {adj ? (
                      <>
                        <div className="font-mono text-[10.5px] text-ink-mute line-through">{formatCurrency(ln.amount)}</div>
                        <div className="font-mono text-[12.5px] text-grass">{formatCurrency(ln.amount - adj.value)}</div>
                      </>
                    ) : (
                      <div className="font-mono text-[12.5px] text-ink">{formatCurrency(ln.amount)}</div>
                    )}
                  </div>
                  {adj ? (
                    <button
                      title="Remove adjustment"
                      onClick={() => {
                        const next = { ...adjustments }; delete next[ln.key]; setAdjustments(next)
                      }}
                      className="flex-none h-6 w-6 rounded-md border border-line bg-bg-elev text-ink-mute text-[12px] hover:border-coral hover:text-coral"
                    >
                      ×
                    </button>
                  ) : (
                    <button
                      onClick={() => openEditor(ln.key)}
                      className="flex-none h-6 px-2.5 rounded-md border border-line bg-bg-elev text-ink-dim text-[11px] font-medium hover:border-cyan hover:text-cyan"
                    >
                      Adjust
                    </button>
                  )}
                </div>
                {adj && (
                  <div className="inline-flex items-center gap-1.5 mt-1.5 font-mono text-[10px] text-coral bg-coral/10 border border-coral/30 rounded-md px-2 py-[3px]">
                    {adj.label} · {adj.reason}
                  </div>
                )}
                {editing === ln.key && (
                  <div className="mt-2 bg-bg-elev border border-line rounded-lg p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex border border-line rounded-lg overflow-hidden">
                        <button onClick={() => setMode("$")} className={`h-[26px] px-2.5 text-[12px] font-semibold font-mono ${seg(mode === "$")}`}>$</button>
                        <button onClick={() => setMode("%")} className={`h-[26px] px-2.5 text-[12px] font-semibold font-mono border-l border-line ${seg(mode === "%")}`}>%</button>
                        <button onClick={() => setMode("comp")} className={`h-[26px] px-2.5 text-[11px] font-semibold border-l border-line ${seg(mode === "comp")}`}>Comp</button>
                      </div>
                      {mode !== "comp" && (
                        <input
                          value={amt}
                          onChange={(e) => { setAmt(e.target.value); setErr("") }}
                          placeholder={mode === "$" ? "0.00" : "0"}
                          className="w-[90px] h-[26px] bg-bg border border-line rounded-lg px-2 text-[12.5px] font-mono text-ink outline-none focus:border-cyan"
                        />
                      )}
                      <span className="font-mono text-[11px] text-teal">
                        {(() => {
                          const v = mode === "comp" ? ln.amount : parseFloat(amt)
                          if (!isFinite(v) || v <= 0) return ""
                          const val = mode === "%" ? Math.min((ln.amount * v) / 100, ln.amount) : Math.min(v, ln.amount)
                          return `−${formatCurrency(val)} → ${formatCurrency(ln.amount - val)}`
                        })()}
                      </span>
                    </div>
                    <input
                      value={reason}
                      onChange={(e) => { setReason(e.target.value); setErr("") }}
                      placeholder="Reason (required)"
                      className="h-7 bg-bg border border-line rounded-lg px-2 text-[12px] text-ink outline-none focus:border-cyan"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => applyAdjustment(ln)}
                        className="h-[26px] px-3 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold"
                      >
                        Apply
                      </button>
                      <button onClick={() => setEditing(null)} className="h-[26px] px-2 text-[12px] text-ink-dim">
                        Cancel
                      </button>
                      {err && <span className="text-[11px] text-sun">{err}</span>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          <div className="px-5 py-3 flex flex-col gap-1.5">
            <div className="flex justify-between text-[12px] text-ink-dim">
              <span>Subtotal</span>
              <span className="font-mono">{formatCurrency(subtotal)}</span>
            </div>
            {discTotal > 0 && (
              <div className="flex justify-between text-[12px] text-coral">
                <span>Adjustments ({Object.keys(adjustments).length}) — draft only</span>
                <span className="font-mono">−{formatCurrency(discTotal)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline border-t border-line pt-2 mt-0.5">
              <span className="text-[12px] font-medium">Total</span>
              <span className="font-display text-[19px] text-ink">{formatCurrency(total)}</span>
            </div>
            {discTotal > 0 && (
              <div className="text-[10.5px] text-ink-mute">
                Pending discounts — hit Apply Discounts (top of the ledger) to write them
                to the QBO invoice.
              </div>
            )}
          </div>

          {/* why-flagged context: monthly chem history vs self + peer medians */}
          {flagContext && flagContext.history.length > 0 && (() => {
            const hist = flagContext.history
            const thisMonth = hist[hist.length - 1]
            const season = seasonOf(String(thisMonth.month))
            const median = (xs: number[]) => {
              if (!xs.length) return null
              const a = [...xs].sort((x, y) => x - y)
              return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
            }
            // self median compares like months: same season only (chem usage
            // swings seasonally); fall back to all prior months when the
            // season has no history yet
            const sameSeason = hist.slice(0, -1)
              .filter((h) => seasonOf(String(h.month)) === season)
              .map((h) => Number(h.chem_usd))
            const allPrior = hist.slice(0, -1).map((h) => Number(h.chem_usd))
            const seasonal = sameSeason.length > 0
            const selfBasis = seasonal ? sameSeason : allPrior
            const selfMedian = median(selfBasis)
            const peerMedian = flagContext.peerMedian != null ? Number(flagContext.peerMedian) : null
            const max = Math.max(...hist.map((h) => Number(h.chem_usd)), peerMedian ?? 0, 1)
            return (
              <div className="px-5 pb-5 pt-1">
                <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-2">
                  Chem $ by month
                </div>
                <div className="flex items-end gap-1 h-[72px] relative">
                  {peerMedian != null && (
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-ink-mute/50"
                      style={{ bottom: `${Math.min(100, (peerMedian / max) * 100)}%` }}
                      title={`Peer median ${formatCurrency(peerMedian)}`}
                    />
                  )}
                  {hist.map((h, i) => {
                    const last = i === hist.length - 1
                    return (
                      <div
                        key={h.month}
                        className="flex-1 flex flex-col items-center gap-1 min-w-0"
                        title={`${String(h.month).slice(0, 7)} · ${formatCurrency(Number(h.chem_usd))} · ${h.visits} visits`}
                      >
                        <div
                          className={`w-full rounded-t ${
                            last ? "bg-sun"
                            : seasonOf(String(h.month)) === season ? "bg-cyan/50" : "bg-cyan/15"
                          }`}
                          style={{ height: `${Math.max(2, (Number(h.chem_usd) / max) * 64)}px` }}
                        />
                        <span className="font-mono text-[8px] text-ink-mute">
                          {new Date(h.month + "T12:00:00Z").toLocaleDateString("en-US", { month: "narrow", timeZone: "UTC" })}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  <div>
                    <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">This month</div>
                    <div className="font-mono text-[13px] text-sun">{formatCurrency(Number(thisMonth.chem_usd))}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">
                      Self median{" "}
                      <span className="normal-case">
                        ({seasonal ? `${SEASON_LABEL[season]}, ${selfBasis.length} mo` : `all ${selfBasis.length} mo`})
                      </span>
                    </div>
                    <div className="font-mono text-[13px] text-ink">
                      {selfMedian != null ? formatCurrency(selfMedian) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">
                      Peer median{" "}
                      <span className="normal-case">
                        (this month{flagContext.peerN != null ? `, n=${flagContext.peerN}` : ""})
                      </span>
                    </div>
                    <div className="font-mono text-[13px] text-ink">
                      {peerMedian != null ? formatCurrency(peerMedian) : "—"}
                    </div>
                  </div>
                </div>
                {flagContext.peerGroup && (
                  <div className="mt-1 text-[10px] text-ink-mute">{flagContext.peerGroup}</div>
                )}
              </div>
            )
          })()}
        </div>

        {/* RIGHT: analysis + visit log */}
        <div className="p-4 lg:p-5 bg-bg-elev/40 flex flex-col gap-3.5 min-h-0">
          {/* AI bill analysis */}
          <div className="bg-bg border border-line rounded-xl overflow-hidden flex-none">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line-soft">
              <span className="font-display text-[15px]">Bill analysis</span>
              <span className="text-[11px] text-ink-mute truncate">
                {notes.length > 0 ? notes.join(" · ") : reasons.map((r) => r.replaceAll("_", " ")).join(", ")}
              </span>
              <div className="flex-1" />
              {analysis && !analyzing && (
                <span className="font-mono text-[9.5px] text-ink-mute">
                  {new Date(analysis.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                </span>
              )}
              <button
                onClick={analyze}
                disabled={analyzing}
                className={
                  analysis
                    ? "h-6 px-2.5 rounded-md border border-line bg-bg-elev text-ink-dim text-[10.5px] hover:border-cyan hover:text-cyan disabled:opacity-50"
                    : "h-7 px-3 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"
                }
              >
                {analyzing ? "Analyzing…" : analysis ? "Re-run" : "Analyze this bill"}
              </button>
            </div>
            {analyzing && (
              <div className="px-4 py-3 flex items-center gap-2.5 text-[12px] text-cyan">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-cyan/25 border-t-cyan animate-spin" />
                Reading {visits.length} visit logs, history, and photos…
              </div>
            )}
            {analysisErr && !analyzing && (
              <div className="px-4 py-3 text-[12px] text-coral">{analysisErr}</div>
            )}
            {!analysis && !analyzing && !analysisErr && (
              <div className="px-4 py-3 text-[12px] text-ink-mute leading-relaxed">
                Sends this bill + {visits.length} visit logs + monthly history + peer stats
                {" "}+ photos to the model. Returns the likely driver, whether it&apos;s normal
                for this customer, and a recommended action.
              </div>
            )}
            {analysis && !analyzing && (
              <div className="px-4 py-3 flex flex-col gap-2.5">
                {([["Driver", "text-sun", analysis.result.driver],
                   ["Normal?", "text-teal", analysis.result.normal],
                   ["Recommend", "text-cyan", analysis.result.recommend]] as const).map(([k, cls, v]) => (
                  <div key={k} className="grid grid-cols-[86px_1fr] gap-2.5 items-baseline">
                    <span className={`font-mono text-[9.5px] uppercase tracking-[0.1em] ${cls}`}>{k}</span>
                    <span className="text-[12.5px] leading-relaxed text-ink">{v ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* visit log — the reusable ServiceLog component (period locked to
              the invoice month in this context) */}
          <ServiceLog visits={visits} period={{ label: monthLabel }} />
        </div>
      </div>

      {/* add-to-watchlist modal */}
      {watchOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center"
          onClick={() => setWatchOpen(false)}
        >
          <div
            className="w-[340px] bg-bg-surface border border-line rounded-xl p-5 shadow-card flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <div className="font-display text-[15px]">Add to watchlist</div>
              <div className="text-[11.5px] text-ink-mute mt-0.5">
                {customerName} — flags the pool for follow-up; resolve returns it to good.
              </div>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">Reason</div>
              <select
                value={watchReason}
                onChange={(e) => setWatchReason(e.target.value)}
                className="w-full h-9 bg-bg-elev border border-line rounded-lg px-2.5 text-[12.5px] text-ink outline-none focus:border-cyan"
              >
                <option value="watch">General watch</option>
                <option value="green_pool">Green pool</option>
                <option value="equipment_down">Equipment down</option>
                <option value="low_chlorine">Chronic low chlorine</option>
              </select>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">Priority</div>
              <select
                value={watchPriority}
                onChange={(e) => setWatchPriority(Number(e.target.value))}
                className="w-full h-9 bg-bg-elev border border-line rounded-lg px-2.5 text-[12.5px] text-ink outline-none focus:border-cyan"
              >
                <option value={1}>Critical</option>
                <option value={2}>High</option>
                <option value={3}>Medium</option>
                <option value={4}>Low</option>
              </select>
            </div>
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-1">Note</div>
              <input
                value={watchNote}
                onChange={(e) => setWatchNote(e.target.value)}
                placeholder="Optional — what to look for"
                className="w-full h-9 bg-bg-elev border border-line rounded-lg px-2.5 text-[12.5px] text-ink outline-none focus:border-cyan"
              />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={addWatch}
                disabled={watchBusy}
                className="h-9 px-4 rounded-lg bg-gradient-to-b from-sun to-sun/80 text-bg text-[12.5px] font-semibold hover:brightness-110 disabled:opacity-50"
              >
                {watchBusy ? "Adding…" : "Add to watchlist"}
              </button>
              <button
                onClick={() => setWatchOpen(false)}
                className="h-9 px-3 rounded-lg text-[12.5px] text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
