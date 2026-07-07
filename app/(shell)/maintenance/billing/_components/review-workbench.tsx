"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { formatCurrency } from "@/lib/utils/format"

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

export interface WorkbenchVisit {
  visit_id: string
  visit_date: string
  ion_log_id: string | null
  service_name: string | null
  tech: string | null
  minutes: number | null
  notes: string | null
  readings: Record<string, string>
  chems: { item: string; qty: number; cents: number; category: string | null }[]
  photos: { guid: string; thumb_url: string; s3_key: string; uploaded_by: string | null }[]
}

export interface BillAnalysis {
  result: { driver?: string; normal?: string; recommend?: string }
  model: string | null
  created_at: string
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

const READING_SHORT: Record<string, string> = {
  "Free Chlorine": "FC", pH: "pH", "Total Alkalinity": "TA",
  "Cyanuric Acid": "CYA", Salinity: "SALT", "Total Chlorine": "TC",
  "Calcium Hardness": "CAL",
}

// readings shown as chips on every preview row (when recorded); everything
// else lands in the expanded view
const PREVIEW_READINGS = [
  "Free Chlorine", "pH", "Cyanuric Acid", "Total Alkalinity",
  "Calcium Hardness", "Salinity",
]

function readingWarn(name: string, value: string): boolean {
  const v = parseFloat(value)
  if (!isFinite(v)) return false
  if (name === "Free Chlorine") return v < 1.5
  if (name === "pH") return v > 7.8 || v < 7.0
  if (name === "Total Alkalinity") return v < 70 || v > 120
  return false
}

function bare(name: string | null | undefined): string {
  if (!name) return "—"
  return name.split(":").pop()!.trim()
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
}) {
  const router = useRouter()
  const [openVisit, setOpenVisit] = useState<string | null>(null)
  const [adjustments, setAdjustments] = useState<Record<string, Adjustment>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [mode, setMode] = useState<"$" | "%" | "comp">("$")
  const [amt, setAmt] = useState("")
  const [reason, setReason] = useState("")
  const [err, setErr] = useState("")
  const [releasing, setReleasing] = useState(false)
  const [applyState, setApplyState] = useState("")
  const [analysis, setAnalysis] = useState<BillAnalysis | null>(initialAnalysis)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisErr, setAnalysisErr] = useState("")
  const [lightbox, setLightbox] = useState<{ photos: WorkbenchVisit["photos"]; i: number } | null>(null)

  // lightbox keyboard: Escape closes, arrows move between the visit's photos
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null)
      if (e.key === "ArrowRight")
        setLightbox((lb) => lb && { ...lb, i: (lb.i + 1) % lb.photos.length })
      if (e.key === "ArrowLeft")
        setLightbox((lb) => lb && { ...lb, i: (lb.i - 1 + lb.photos.length) % lb.photos.length })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [lightbox])

  const usualByItem = useMemo(() => {
    const m = new Map<string, UsualItem>()
    for (const u of usual) m.set(u.item_name.toUpperCase(), u)
    return m
  }, [usual])

  // flatten invoice lines; key = invoiceId:index
  const lines = useMemo(() => {
    const out: {
      key: string; invoice: WorkbenchInvoice; name: string; detail: string
      amount: number; usual: UsualItem | undefined
    }[] = []
    for (const inv of invoices) {
      for (const [i, li] of (inv.line_items ?? []).entries()) {
        if (li.line_type && li.line_type !== "item") continue
        const amount = Number(li.amount ?? 0)
        const name = bare(li.item_name)
        const qty = li.qty != null ? Number(li.qty) : null
        const rate = li.unit_price != null ? Number(li.unit_price) : null
        out.push({
          key: `${inv.qbo_invoice_id}:${i}`,
          invoice: inv,
          name,
          detail: qty != null && rate != null
            ? `${qty} × ${formatCurrency(rate)}`
            : (li.description ?? ""),
          amount,
          usual: usualByItem.get(name.toUpperCase()),
        })
      }
    }
    return out
  }, [invoices, usualByItem])

  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const discTotal = Object.values(adjustments).reduce((s, a) => s + a.value, 0)
  const total = subtotal - discTotal
  const totalDue = invoices.reduce((s, i) => s + Number(i.balance ?? 0), 0)

  const queueIdx = queue.findIndex((q) => q.customerId === customerId)
  const nextInQueue = queueIdx >= 0 ? queue[queueIdx + 1] ?? null : null
  const prevInQueue = queueIdx > 0 ? queue[queueIdx - 1] : null
  const billHref = (id: number) => `/maintenance/billing/review/${id}/bill?month=${month}`

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

  // Approve = write draft adjustments to QBO (one batch per invoice) then
  // release the held periods. No half-states: a failed write aborts before
  // any release.
  async function release() {
    setReleasing(true)
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
        setApplyState(`Applying ${n} adjustment${n === 1 ? "" : "s"} to QBO…`)
        const r = await fetch("/api/maintenance-billing/adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qbo_invoice_id, adjustments: adjs }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? "adjustment trigger failed")
        await pollJob(`/api/maintenance-billing/adjustments?job=${j.jobId}`)
      }
      setApplyState("Releasing…")
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

  const flaggedVisits = visits.filter((v) =>
    Object.entries(v.readings).some(([k, val]) => readingWarn(k, val)),
  ).length
  const avgMins = (() => {
    const withMins = visits.filter((v) => v.minutes != null)
    if (!withMins.length) return null
    return Math.round(withMins.reduce((s, v) => s + (v.minutes ?? 0), 0) / withMins.length)
  })()

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
          onClick={release}
          disabled={releasing}
          className="h-8 px-3.5 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"
        >
          {releasing
            ? applyState || "Working…"
            : Object.keys(adjustments).length > 0
              ? `Apply ${Object.keys(adjustments).length} + approve${nextInQueue ? " → next" : ""}`
              : nextInQueue ? "Approve → next" : "Approve → ready"}
        </button>
        {!releasing && applyState.startsWith("Failed") && (
          <span className="text-[11px] text-coral max-w-[260px]">{applyState}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[430px_1fr] lg:h-[680px]">
        {/* LEFT: invoice ledger */}
        <div className="border-r border-line-soft pt-2 overflow-y-auto min-h-0">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute px-5 py-2">
            Invoice lines
          </div>
          {lines.length === 0 && (
            <div className="px-5 py-8 text-center text-[12px] text-ink-mute">
              No line items on the linked invoice{invoices.length === 1 ? "" : "s"}.
            </div>
          )}
          {lines.map((ln) => {
            const adj = adjustments[ln.key]
            const u = ln.usual
            const now = u?.month_usd != null ? Number(u.month_usd) : null
            const avg = u?.usual_usd != null ? Number(u.usual_usd) : null
            const delta = now != null && avg != null && avg > 0 ? ((now - avg) / avg) * 100 : null
            const max = now != null && avg != null ? Math.max(now, avg) : null
            const deltaColor = delta == null ? "text-ink-mute"
              : Math.abs(delta) <= 15 ? "text-ink-mute"
              : Math.abs(delta) <= 60 ? "text-sun" : "text-coral"
            return (
              <div key={ln.key} className="border-b border-line-soft px-5 py-2.5 hover:bg-white/[0.015]">
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-ink">{ln.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-mute mt-0.5">
                      {ln.detail}
                      {invoices.length > 1 && (
                        <span> · #{ln.invoice.doc_number}</span>
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
                {max != null && max > 0 && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="w-[92px]">
                      <div className="h-1 bg-line-soft rounded-full overflow-hidden mb-[3px]">
                        <div className="h-full bg-cyan" style={{ width: `${Math.round(((now ?? 0) / max) * 100)}%` }} />
                      </div>
                      <div className="h-1 bg-line-soft rounded-full overflow-hidden">
                        <div className="h-full bg-ink-mute" style={{ width: `${Math.round(((avg ?? 0) / max) * 100)}%` }} />
                      </div>
                    </div>
                    <span className="font-mono text-[10px] text-ink-mute">
                      usual {formatCurrency(avg ?? 0)}
                    </span>
                    {delta != null && (
                      <span className={`font-mono text-[10px] ${deltaColor}`}>
                        {delta >= 0 ? "▲" : "▼"}{Math.abs(Math.round(delta))}%
                      </span>
                    )}
                  </div>
                )}
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
                Drafts are written to the QBO invoice as DISCOUNT lines when you approve.
              </div>
            )}
          </div>
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
                  {new Date(analysis.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
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

          {/* visit log */}
          <div className="bg-bg border border-line rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft flex-none">
              <span className="font-display text-[15px]">Service log — {monthLabel}</span>
              <span className="font-mono text-[10.5px] text-ink-mute">
                {visits.length} visit{visits.length === 1 ? "" : "s"}
                {flaggedVisits > 0 && <> · <span className="text-coral">{flaggedVisits} off-range</span></>}
                {avgMins != null && <> · avg {avgMins} min</>}
              </span>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0">
              {visits.map((v) => {
                const open = openVisit === v.visit_id
                const warn = Object.entries(v.readings).some(([k, val]) => readingWarn(k, val))
                const chemCents = v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
                const previewReads = PREVIEW_READINGS
                  .filter((k) => v.readings[k] != null && v.readings[k] !== "")
                  .map((k) => [k, v.readings[k]] as const)
                const otherReads = Object.entries(v.readings)
                  .filter(([k, val]) => !PREVIEW_READINGS.includes(k) && val != null && val !== "")
                return (
                  <div key={v.visit_id} className="border-b border-line-soft last:border-0">
                    <div
                      onClick={() => setOpenVisit(open ? null : v.visit_id)}
                      className="flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-white/[0.02]"
                    >
                      <span className={`w-[7px] h-[7px] rounded-full flex-none ${warn ? "bg-coral" : "bg-grass"}`} />
                      <div className="w-[86px] flex-none">
                        <div className="font-mono text-[11px] text-ink">
                          {new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
                        </div>
                        <div className="font-mono text-[9.5px] text-ink-mute mt-px">
                          {(v.tech ?? "—").split(" ").map((w, i, a) => (i === a.length - 1 && a.length > 1 ? w[0] : w)).join(" ")}
                          {v.minutes != null && ` · ${v.minutes}m`}
                        </div>
                      </div>
                      <div className="w-[300px] flex-none flex items-center gap-1 flex-wrap py-0.5">
                        {previewReads.map(([k, val]) => {
                          const w = readingWarn(k, val)
                          return (
                            <span key={k}
                              className={`inline-flex items-baseline gap-1 rounded border px-1.5 py-[1px] flex-none ${w ? "border-coral/40 bg-coral/5" : "border-line bg-bg-elev"}`}>
                              <span className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">{READING_SHORT[k]}</span>
                              <span className={`font-mono text-[10.5px] ${w ? "text-coral" : "text-ink"}`}>{val}</span>
                            </span>
                          )
                        })}
                        {previewReads.length === 0 && <span className="text-[10px] text-ink-mute">no readings</span>}
                      </div>
                      <span className="w-px self-stretch bg-line-soft flex-none" />
                      <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap py-0.5">
                        {v.chems.map((c, ci) => (
                          <span key={ci}
                            title={c.cents ? formatCurrency(c.cents / 100) : undefined}
                            className="inline-flex items-baseline gap-1 rounded border border-teal/30 bg-teal/5 px-1.5 py-[1px] flex-none">
                            <span className="font-mono text-[10.5px] text-teal">{c.qty}</span>
                            <span className="text-[10px] text-ink-dim">{bare(c.item)}</span>
                          </span>
                        ))}
                        {v.chems.length === 0 && <span className="text-[10px] text-ink-mute">no chems sold</span>}
                      </div>
                      {v.photos.length > 0 && (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-mute flex-none">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                            <circle cx="12" cy="13" r="3" />
                          </svg>
                          {v.photos.length}
                        </span>
                      )}
                      <span className="font-mono text-[12px] text-ink w-[64px] text-right flex-none">
                        {chemCents > 0 ? formatCurrency(chemCents / 100) : "—"}
                      </span>
                      <span
                        className="text-ink-mute text-[10px] flex-none transition-transform duration-150"
                        style={{ transform: `rotate(${open ? 180 : 0}deg)` }}
                      >
                        ▾
                      </span>
                    </div>
                    {open && (
                      <div className="px-4 pb-3.5 pl-9 flex flex-col gap-2.5">
                        {otherReads.length > 0 && (
                          <div className="flex gap-1.5 flex-wrap">
                            {otherReads.map(([k, val]) => (
                              <div key={k} className="bg-bg-elev border border-line rounded-md px-2 py-1 text-center">
                                <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-mute">
                                  {READING_SHORT[k] ?? k}
                                </div>
                                <div className="font-mono text-[12px] text-ink">{val}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        {v.notes && (
                          <div className="text-[11.5px] leading-relaxed text-ink-dim border-l-2 border-line pl-2.5">
                            {v.notes}
                          </div>
                        )}
                        {otherReads.length === 0 && !v.notes && v.photos.length === 0 && (
                          <div className="text-[11px] text-ink-mute">No notes, photos, or additional readings.</div>
                        )}
                        {v.photos.length > 0 && (
                          <div className="flex gap-2 flex-wrap">
                            {v.photos.map((p, pi) => (
                              <button
                                key={p.guid}
                                onClick={() => setLightbox({ photos: v.photos, i: pi })}
                                className="block w-[104px] group"
                                title={p.uploaded_by ? `Uploaded by ${p.uploaded_by}` : undefined}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={p.thumb_url}
                                  alt="Service log photo"
                                  className="h-16 w-full object-cover rounded-lg border border-line group-hover:border-cyan"
                                />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {visits.length === 0 && (
                <div className="px-4 py-8 text-center text-[12px] text-ink-mute">
                  No visits recorded for this customer-month.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* photo lightbox — click anywhere / Escape to close, arrows to browse */}
      {lightbox && (() => {
        const p = lightbox.photos[lightbox.i]
        return (
          <div
            className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center cursor-zoom-out"
            onClick={() => setLightbox(null)}
          >
            {/* full-size loads via the signed-URL redirect; the public thumb
                shows instantly underneath so there's no blank flash */}
            <div className="relative max-w-[92vw] max-h-[90vh]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumb_url}
                alt=""
                aria-hidden
                className="absolute inset-0 w-full h-full object-contain blur-[2px] opacity-60"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={p.guid}
                src={`/api/maintenance-billing/photo?key=${encodeURIComponent(p.s3_key)}`}
                alt="Service log photo"
                className="relative max-w-[92vw] max-h-[90vh] object-contain rounded-lg"
              />
            </div>
            {lightbox.photos.length > 1 && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setLightbox({ ...lightbox, i: (lightbox.i - 1 + lightbox.photos.length) % lightbox.photos.length })
                  }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-[18px]"
                  aria-label="Previous photo"
                >
                  ‹
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setLightbox({ ...lightbox, i: (lightbox.i + 1) % lightbox.photos.length })
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-[18px]"
                  aria-label="Next photo"
                >
                  ›
                </button>
              </>
            )}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[11px] text-white/70">
              {lightbox.photos.length > 1 && `${lightbox.i + 1} / ${lightbox.photos.length} · `}
              {p.uploaded_by && `by ${p.uploaded_by} · `}click anywhere to close
            </div>
            <button
              onClick={() => setLightbox(null)}
              className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/10 hover:bg-white/20 text-white text-[16px]"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        )
      })()}
    </div>
  )
}
