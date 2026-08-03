"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"
import { DraftInvoicePanel } from "./draft-invoice-panel"
import type { FindingGroup } from "../_lib/findings"

/**
 * The findings review workbench — the bill-review detail's shape: header
 * card (customer, month, CPV context, total flagged, the review action),
 * invoice lines on the left (the DRAFT invoice — regenerated on demand from
 * the aggregate), and on the right the report panel (where bill-review has
 * "what's driving") above the per-visit service log with flagged visits
 * highlighted. Resolving auto-advances to the next open customer.
 */

export interface WorkbenchVisit {
  visit_id: string
  visit_date: string
  tech: string | null
  minutes: number | null
  notes: string | null
  readings: Record<string, string>
  chems: { item: string; qty: number; cents: number | null }[]
}

const READINGS: [string, string][] = [
  ["Free Chlorine", "FC"],
  ["pH", "pH"],
  ["Cyanuric Acid", "CYA"],
  ["Total Alkalinity", "TA"],
  ["Salinity", "Salt"],
]

/** Peer/self CPV parsed from the finding's own sentence — the domain wrote
 *  both sides. (Upgrade path: persist observation context on the row.) */
function cpvContext(g: FindingGroup): { peerGroup: string | null; peerP95: string | null; selfMedian: string | null } {
  const m = g.findings[0]?.message ?? ""
  const peer = m.match(/95th percentile of (\S+) \(\$([\d,.]+)\)/)
  const self = m.match(/own median \(\$([\d,.]+)\)/)
  return { peerGroup: peer?.[1] ?? null, peerP95: peer?.[2] ?? null, selfMedian: self?.[1] ?? null }
}

export function FindingsWorkbench({
  group,
  queue,
  visits,
}: {
  group: FindingGroup
  queue: { customerId: number; name: string }[]
  visits: WorkbenchVisit[]
}) {
  const router = useRouter()
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const monthParam = group.month.slice(0, 7)
  const i = queue.findIndex((q) => q.customerId === group.customerId)
  const prev = i > 0 ? queue[i - 1] : null
  const next = i >= 0 && i < queue.length - 1 ? queue[i + 1] : null
  const hrefFor = (customerId: number) => `/maintenance/billing/findings/${customerId}?month=${monthParam}`

  const flagged = new Set(
    group.findings.map((f) => f.message.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  )
  const ctx = cpvContext(group)
  const ordered = [...visits].sort((a, b) => b.visit_date.localeCompare(a.visit_date))
  const chemOf = (v: WorkbenchVisit) => v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
  const monthChem = visits.reduce((s, v) => s + chemOf(v), 0)

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
    router.push((next ? hrefFor(next.customerId) : `/maintenance/billing/findings`) as never)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Findings review · {monthParam}
          </div>
          <h2 className="font-display text-[18px] mt-0.5">{group.customerName}</h2>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          {prev ? (
            <Link href={hrefFor(prev.customerId) as never} title={prev.name} className="text-ink-mute hover:text-ink underline underline-offset-2">
              Prev
            </Link>
          ) : null}
          <span className="text-ink-mute">{i + 1} of {queue.length} open</span>
          {next ? (
            <Link href={hrefFor(next.customerId) as never} title={next.name} className="text-ink-mute hover:text-ink underline underline-offset-2">
              Next
            </Link>
          ) : null}
          <Link href={`/maintenance/billing/findings` as never} className="text-ink-mute hover:text-ink underline underline-offset-2">
            Back to findings
          </Link>
        </div>
      </div>

      {/* header card — the bill-review shape: identity left, money + action right */}
      <div className="rounded-lg border border-line-soft px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ink text-[14px]">{group.customerName}</span>
          <span className="text-ink-mute text-[12px]">{monthParam}</span>
          <Pill tone="sun">
            {group.findings.length} visit{group.findings.length === 1 ? "" : "s"} flagged
          </Pill>
          {flagged.size > 0 && (
            <span className="text-[11px] text-ink-mute">
              peer p95 {ctx.peerP95 ? `$${ctx.peerP95}` : "—"}
              {ctx.peerGroup ? ` (${ctx.peerGroup})` : ""} · self median{" "}
              {ctx.selfMedian ? `$${ctx.selfMedian}` : "no history yet"}
            </span>
          )}
          {group.monthInvoiced && <Pill tone="neutral">invoiced</Pill>}
          <div className="ml-auto text-right">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-mute">Flagged $</div>
            <div className="font-mono num text-[18px] text-sun">{formatCurrency(group.totalCents / 100)}</div>
          </div>
        </div>
        {group.openIds.length > 0 ? (
          <div className="mt-3 flex items-start gap-3">
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={1}
              placeholder="Resolution (required) — what was decided and why"
              className="flex-1 rounded border border-line-soft bg-transparent px-2.5 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:border-cyan/50"
            />
            <button
              onClick={resolve}
              disabled={busy || !resolution.trim()}
              className="text-[12px] px-3.5 py-2 rounded bg-cyan/15 border border-cyan/40 text-cyan hover:bg-cyan/25 disabled:opacity-40 whitespace-nowrap"
            >
              {busy ? "Saving" : "Mark reviewed"}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-3 text-[12px]">
            <Pill tone="grass">Reviewed</Pill>
            <span className="text-ink-mute">{group.resolvedBy}</span>
            <span className="text-ink-dim">{group.findings[0]?.resolution}</span>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-coral">{error}</p>}
      </div>

      <div className="grid grid-cols-[340px_1fr] gap-4 items-start">
        {/* left: what the invoice will say — the draft, regenerated on demand */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute mb-2">Invoice lines (draft)</div>
          <DraftInvoicePanel monthId={group.monthId} />
        </div>

        {/* right: the report slot (bill-review's "what's driving"), then the service log */}
        <div className="space-y-4">
          <div className="rounded-lg border border-line-soft px-4 py-3 flex items-center gap-3">
            <div className="flex-1 text-[12px] text-ink-dim">
              Generate the chemical-usage report for this month — the context document to attach alongside the
              customer&apos;s invoice. Built on demand from the service log; flagged visits are marked.
            </div>
            <a
              href={`/billing-report/${group.customerId}?month=${monthParam}`}
              target="_blank"
              className="text-[12px] px-3 py-1.5 rounded border border-cyan/40 text-cyan hover:bg-cyan/10 whitespace-nowrap"
            >
              Generate PDF report
            </a>
          </div>

          <div className="rounded-lg border border-line-soft overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 bg-white/[0.02] border-b border-line-soft text-[11px]">
              <span className="text-ink font-medium">Service log</span>
              <span className="text-ink-mute">{monthParam}</span>
              <span className="ml-auto text-ink-mute">
                {visits.length} visits · <span className="text-sun">{flagged.size} flagged</span> · chems{" "}
                <span className="font-mono num text-ink">{formatCurrency(monthChem / 100)}</span>
              </span>
            </div>
            <div>
              {ordered.map((v) => {
                const isFlagged = flagged.has(v.visit_date.slice(0, 10))
                return (
                  <div
                    key={v.visit_id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2 border-b border-line-soft/50 last:border-b-0",
                      isFlagged && "bg-coral/[0.06]",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", isFlagged ? "bg-coral" : "bg-grass/60")} />
                    <div className="w-24 shrink-0">
                      <div className="text-[12px] text-ink font-mono num">{fmtDay(v.visit_date)}</div>
                      <div className="text-[10px] text-ink-mute truncate">
                        {v.tech ?? "—"}
                        {v.minutes != null && ` · ${v.minutes}m`}
                      </div>
                    </div>
                    <div className="flex gap-3 shrink-0">
                      {READINGS.map(([name, label]) => {
                        const val = v.readings?.[name]
                        if (val == null) return null
                        return (
                          <span key={name} className="text-[11px] font-mono num text-ink-dim">
                            <span className="text-ink-mute">{label}</span> {val}
                          </span>
                        )
                      })}
                    </div>
                    <div className="flex-1 text-[11px] text-ink-mute truncate">
                      {v.chems.length > 0
                        ? v.chems.map((c) => `${c.item} × ${c.qty}`).join(", ")
                        : v.notes ?? ""}
                    </div>
                    <span className={cn("font-mono num text-[12px] shrink-0", isFlagged ? "text-sun" : "text-ink-dim")}>
                      {chemOf(v) > 0 ? formatCurrency(chemOf(v) / 100) : "—"}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** '2026-07-22' -> 'Tue, Jul 22' */
function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso.slice(0, 10) + "T12:00:00Z"))
}
