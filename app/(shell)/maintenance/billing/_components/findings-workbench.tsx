"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { formatCurrency } from "@/lib/utils/format"
import { ServiceLog, type ServiceLogVisit } from "../../_components/service-log"
import { ChemHistoryContext, type FlagContext } from "./chem-history-context"
import type { FindingGroup } from "../_lib/findings"

/**
 * The audit findings workbench — the bill-review workbench's EXACT chrome
 * (same header, same 430px/flex grid, same left ledger + right analysis/log
 * layout, same ServiceLog and chem-history components), fed by the NEW
 * module's read models. The one thing this module doesn't have yet is a
 * QBO invoice, so the left ledger shows the DRAFT invoice — the aggregate
 * projection, regenerated on every read. The bill-analysis slot generates
 * the usage report to attach alongside the invoice. Approve's slot is Mark
 * Reviewed: one resolution clears the customer's findings and auto-advances
 * to the next open customer.
 */

interface DraftLine {
  kind: string
  itemName: string
  qty: number
  unitPriceCents: number
  amountCents: number
  detail: string | null
}
interface Draft {
  lines: DraftLine[]
  subtotalCents: number
  claimedAtZero: number
}

export function FindingsWorkbench({
  group,
  queue,
  visits,
  flagContext,
}: {
  group: FindingGroup
  queue: { customerId: number; name: string }[]
  visits: ServiceLogVisit[]
  flagContext: FlagContext | null
}) {
  const router = useRouter()
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | "loading" | "error">("loading")

  const month = group.month.slice(0, 7)
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-15T12:00:00Z`))
  const queueIdx = queue.findIndex((q) => q.customerId === group.customerId)
  const prevInQueue = queueIdx > 0 ? queue[queueIdx - 1] : null
  const nextInQueue = queueIdx >= 0 && queueIdx < queue.length - 1 ? queue[queueIdx + 1] : null
  const hrefFor = (customerId: number) => `/maintenance/billing/findings/${customerId}?month=${month}`

  useEffect(() => {
    let alive = true
    setDraft("loading")
    fetch(`/api/billing/months/${group.monthId}/draft-invoice`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setDraft(j as Draft))
      .catch(() => alive && setDraft("error"))
    return () => {
      alive = false
    }
  }, [group.monthId])

  const lines = draft !== "loading" && draft !== "error" ? draft.lines : []
  const subtotal = draft !== "loading" && draft !== "error" ? draft.subtotalCents / 100 : 0

  const resolve = async () => {
    setBusy(true)
    setError(null)
    const res = await fetch("/api/billing/findings/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: group.openIds, resolution }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? `failed (${res.status})`)
      return
    }
    router.push((nextInQueue ? hrefFor(nextInQueue.customerId) : `/maintenance/billing/findings`) as never)
    router.refresh()
  }

  return (
    <div className="rounded-xl border border-line bg-bg-surface overflow-hidden">
      {/* header */}
      <div className="flex items-center gap-3.5 px-5 py-4 border-b border-line-soft flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-[17px] tracking-tight">{group.customerName}</span>
          <span className="font-mono text-[10.5px] text-ink-mute">
            Draft · {monthLabel}
          </span>
          <span className="text-[10px] uppercase tracking-[0.08em] text-sun bg-sun/10 border border-sun/30 rounded-full px-2 py-0.5">
            {group.findings.length} chem outlier visit{group.findings.length === 1 ? "" : "s"}
          </span>
          {group.monthInvoiced ? (
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-bg-elev border border-line rounded-full px-2 py-0.5">Invoiced</span>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-bg-elev border border-line rounded-full px-2 py-0.5">Draft</span>
          )}
          {group.openIds.length === 0 && (
            <span className="text-[10px] uppercase tracking-[0.08em] text-grass bg-grass/10 border border-grass/30 rounded-full px-2 py-0.5">
              Reviewed · {group.resolvedBy}
            </span>
          )}
        </div>
        <div className="flex-1" />
        {queueIdx >= 0 && queue.length > 1 && (
          <div className="flex items-center gap-1.5 mr-2">
            <button
              onClick={() => prevInQueue && router.push(hrefFor(prevInQueue.customerId) as never)}
              disabled={!prevInQueue}
              title={prevInQueue ? `Previous: ${prevInQueue.name}` : undefined}
              className="h-7 w-7 rounded-lg border border-line bg-bg-elev text-ink-dim text-[13px] hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-dim"
              aria-label="Previous open finding"
            >
              ‹
            </button>
            <span className="font-mono text-[10.5px] text-ink-mute whitespace-nowrap">
              {queueIdx + 1} of {queue.length} open
            </span>
            <button
              onClick={() => nextInQueue && router.push(hrefFor(nextInQueue.customerId) as never)}
              disabled={!nextInQueue}
              title={nextInQueue ? `Next: ${nextInQueue.name}` : undefined}
              className="h-7 w-7 rounded-lg border border-line bg-bg-elev text-ink-dim text-[13px] hover:border-cyan hover:text-cyan disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-dim"
              aria-label="Next open finding"
            >
              ›
            </button>
          </div>
        )}
        <div className="text-right mr-1.5">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">Flagged</div>
          <div className="font-display text-[19px] text-sun">{formatCurrency(group.totalCents / 100)}</div>
        </div>
        {group.openIds.length > 0 && (
          <>
            <input
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="Resolution (required) — e.g. verified with tech: genuine treatment / mis-key, visit corrected in ION"
              className="h-9 w-[420px] bg-bg-elev border border-line rounded-lg px-3 text-[12.5px] text-ink placeholder:text-ink-mute outline-none focus:border-cyan"
            />
            <button
              onClick={resolve}
              disabled={busy || !resolution.trim()}
              title={!resolution.trim() ? "A cleared flag needs a reason" : undefined}
              className="h-9 px-3.5 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Mark Reviewed"}
            </button>
          </>
        )}
        {error && <span className="text-[11px] text-coral max-w-[260px]">{error}</span>}
      </div>

      {/* minmax(0,1fr): a bare 1fr can't shrink below the content's
          min-width, so wide service logs used to overflow and get clipped */}
      <div className="grid grid-cols-1 lg:grid-cols-[430px_minmax(0,1fr)] lg:h-[680px]">
        {/* LEFT: the draft invoice ledger */}
        <div className="border-r border-line-soft pt-2 overflow-y-auto min-h-0">
          <div className="flex items-center justify-between px-5 py-2">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-mute">
              Invoice lines — draft, regenerated on demand
            </span>
          </div>
          {draft === "loading" && (
            <div className="px-5 py-8 text-center text-[12px] text-ink-mute">Building the draft…</div>
          )}
          {draft === "error" && (
            <div className="px-5 py-8 text-center text-[12px] text-coral">Failed to build the draft invoice.</div>
          )}
          {lines.map((ln, idx) => (
            <div key={idx} className="border-b border-line-soft px-5 py-2.5 hover:bg-white/[0.015]">
              <div className="flex items-center gap-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium text-ink">{ln.itemName}</div>
                  <div className="font-mono text-[10.5px] text-ink-mute mt-0.5">
                    {ln.kind === "variance"
                      ? ln.detail
                      : `${ln.qty} × ${formatCurrency(ln.unitPriceCents / 100)}`}
                  </div>
                </div>
                <div className="w-[92px] text-right flex-none">
                  <div className="font-mono text-[12.5px] text-ink">{formatCurrency(ln.amountCents / 100)}</div>
                </div>
              </div>
            </div>
          ))}
          {draft !== "loading" && draft !== "error" && (
            <div className="px-5 py-3 flex flex-col gap-1.5">
              <div className="flex justify-between text-[12px] text-ink-dim">
                <span>
                  Subtotal
                  {draft.claimedAtZero > 0 && (
                    <span className="text-ink-mute"> · {draft.claimedAtZero} visit(s) at $0</span>
                  )}
                </span>
                <span className="font-mono">{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between items-baseline border-t border-line pt-2 mt-0.5">
                <span className="text-[12px] font-medium">Total</span>
                <span className="font-display text-[19px] text-ink">{formatCurrency(subtotal)}</span>
              </div>
            </div>
          )}

          {/* why-flagged context: the same graph bill-review shows */}
          {flagContext && <ChemHistoryContext flagContext={flagContext} />}
        </div>

        {/* RIGHT: report + visit log */}
        <div className="p-4 lg:p-5 bg-bg-elev/40 flex flex-col gap-3.5 min-h-0">
          {/* usage report — this module's "what's driving" slot */}
          <div className="bg-bg border border-line rounded-xl overflow-hidden flex-none">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-line-soft">
              <span className="font-display text-[15px]">Usage report</span>
              <span className="text-[11px] text-ink-mute truncate">
                {group.findings.length} flagged visit{group.findings.length === 1 ? "" : "s"} this month
              </span>
              <div className="flex-1" />
              <a
                href={`/billing-report/${group.customerId}?month=${month}`}
                target="_blank"
                className="h-7 px-3 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 inline-flex items-center"
              >
                Generate report
              </a>
            </div>
            <div className="px-4 py-3 text-[12px] text-ink-mute leading-relaxed">
              Builds the customer-safe chemical usage report for {monthLabel} — every visit with readings and
              chemicals added, flagged visits marked. Print → Save as PDF and attach it alongside the invoice.
            </div>
          </div>

          {/* visit log — the same reusable ServiceLog, flagged visits tinted */}
          <ServiceLog
            visits={visits}
            highlightDates={group.findings
              .map((f) => f.message.slice(0, 10))
              .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))}
            period={{
              label: monthLabel,
              start: `${month}-01`,
              end: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10),
            }}
          />
        </div>
      </div>
    </div>
  )
}
