"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { useRouter } from "next/navigation"
import { SortableHeader } from "@/components/ui/sortable-header"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"
import { VisitCalendar } from "./visit-calendar"
import { REASON_LABEL, STATUS_LABEL, STATUS_TONE } from "../_lib/status"
import type { ProcessingStatus } from "../_lib/queries"

export interface TaskLine {
  id: string
  service_name: string | null
  category: string | null
  frequency: string | null
  visits: number
  labor_cents: number | null
  chem_cents: number | null
  expected_cents: number | null
  unpriced: number
  ion_cents: number | null
  ion_numbers: string | null
  ion_match: "match" | "mismatch" | "missing"
  reconcile_status: string
  status: ProcessingStatus
  needs_review_reason: string | null
}

export interface CustomerBill {
  key: string
  customer_id: number | null
  name: string
  on_autopay: boolean
  hold: boolean
  visits: number
  labor_cents: number
  chem_cents: number
  expected_cents: number
  ion_cents: number | null
  qbo_docs: string
  statuses: ProcessingStatus[]
  tasks: TaskLine[]
}

const ION_TONE = { match: "grass", mismatch: "coral", missing: "neutral" } as const
function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

// Column layout; sorting is URL-driven (SortableHeader), sorted + paginated
// server-side in page.tsx — the work-orders pattern.
const COLUMNS: { key: string | null; label: string; align: "left" | "right"; defaultDir: "asc" | "desc" }[] = [
  { key: "name", label: "Customer", align: "left", defaultDir: "asc" },
  { key: "tasks", label: "Tasks", align: "right", defaultDir: "desc" },
  { key: "visits", label: "Visits", align: "right", defaultDir: "desc" },
  { key: "labor", label: "Labor", align: "right", defaultDir: "desc" },
  { key: "chems", label: "Chems", align: "right", defaultDir: "desc" },
  { key: "expected", label: "Expected", align: "right", defaultDir: "desc" },
  { key: "diff", label: "ION diff", align: "right", defaultDir: "desc" },
  { key: null, label: "QBO", align: "left", defaultDir: "asc" },
]

/**
 * The Bills table: one collapsible row per customer. Click a row to reveal the
 * task list and the visit calendar: dates as columns, readings grouped above
 * the chemicals sold per visit, with totals. Sorting/paging live in the URL.
 */
export function BillsTable({
  customers,
  month,
  sort,
  dir,
  basePath,
  preserve,
}: {
  customers: CustomerBill[]
  month: string
  sort: string
  dir: "asc" | "desc"
  basePath: string
  preserve: Record<string, string | undefined>
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }

  return (
    <Card>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft">
            {COLUMNS.map((col) => (
              <th
                key={col.label}
                className={cn("px-4 py-2 font-medium", col.align === "right" && "text-right")}
              >
                {col.key ? (
                  <SortableHeader
                    label={col.label}
                    column={col.key}
                    currentSort={sort}
                    currentDir={dir}
                    basePath={basePath}
                    preserve={preserve}
                    defaultDir={col.defaultDir}
                    align={col.align}
                  />
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-ink-mute">
                No bills match this filter.
              </td>
            </tr>
          )}
          {customers.map((c) => (
            <CustomerRows
              key={c.key}
              c={c}
              month={month}
              open={open.has(c.key)}
              onToggle={() => toggle(c.key)}
            />
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function CustomerRows({
  c,
  month,
  open,
  onToggle,
}: {
  c: CustomerBill
  month: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className="border-b border-line-soft/40 hover:bg-white/[0.02] cursor-pointer align-top"
        onClick={onToggle}
      >
        <td className="px-4 py-2.5 text-ink">
          <span className="text-ink-mute mr-1.5 inline-block w-3">{open ? "▾" : "▸"}</span>
          {c.name}
          {c.on_autopay && (
            <span className="ml-2 text-[10px] text-teal uppercase tracking-wide">autopay</span>
          )}
          {c.hold && (
            <Pill tone="coral" dot className="ml-2">
              hold
            </Pill>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{c.tasks.length}</td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{c.visits}</td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
          {cents(c.labor_cents)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
          {cents(c.chem_cents)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink">
          {cents(c.expected_cents)}
        </td>
        <DiffCell ion_cents={c.ion_cents} expected_cents={c.expected_cents} />
        <td className="px-4 py-2.5 font-mono text-xs text-ink-dim">{c.qbo_docs || "—"}</td>
      </tr>
      {open && (
        <tr className="border-b border-line-soft/40 bg-white/[0.015]">
          <td colSpan={8} className="px-6 py-4">
            <BillDetail c={c} month={month} />
          </td>
        </tr>
      )}
    </>
  )
}

/** ION total minus our expected total, one line: a check mark when they net
 *  to zero (within the $1 pipeline tolerance), the signed difference in coral
 *  when off, an em dash before the ION report has matched. */
function DiffCell({
  ion_cents,
  expected_cents,
}: {
  ion_cents: number | null
  expected_cents: number
}) {
  if (ion_cents == null) {
    return <td className="px-4 py-2.5 text-right text-ink-mute">—</td>
  }
  const diff = ion_cents - expected_cents
  if (Math.abs(diff) <= 100) {
    return (
      <td className="px-4 py-2.5 text-right">
        <span className="text-grass">✓</span>
      </td>
    )
  }
  return (
    <td className="px-4 py-2.5 text-right font-mono num text-coral">
      {diff > 0 ? "+" : "−"}
      {formatCurrency(Math.abs(diff) / 100)}
    </td>
  )
}

/** Manual pipeline transitions for the customer's periods (guarded RPC —
 *  mark-ready stamps reviewed_at; re-projection re-holds unreviewed HIGHs). */
function StatusActions({ tasks }: { tasks: TaskLine[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const reviewable = tasks.filter((t) => t.status === "needs_review")
  const readyable = tasks.filter((t) => t.status === "ready_to_process")

  async function setStatus(ids: string[], status: string) {
    setBusy(true)
    try {
      const r = await fetch("/api/maintenance-billing/periods/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status }),
      })
      if (r.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (reviewable.length === 0 && readyable.length === 0) return null
  return (
    <div className="flex gap-2">
      {reviewable.length > 0 && (
        <button
          disabled={busy}
          onClick={() => setStatus(reviewable.map((t) => t.id), "ready_to_process")}
          className="text-[11px] px-2.5 py-1 rounded border border-teal/30 text-teal hover:bg-teal/10 disabled:opacity-50"
        >
          Mark reviewed → ready ({reviewable.length})
        </button>
      )}
      {readyable.length > 0 && (
        <button
          disabled={busy}
          onClick={() => setStatus(readyable.map((t) => t.id), "processed")}
          className="text-[11px] px-2.5 py-1 rounded border border-grass/30 text-grass hover:bg-grass/10 disabled:opacity-50"
        >
          Mark processed ({readyable.length})
        </button>
      )}
    </div>
  )
}

function BillDetail({ c, month }: { c: CustomerBill; month: string }) {
  return (
    <div className="space-y-4">
      <table className="w-auto min-w-[60%] text-[11px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft">
            <th className="pr-6 py-1.5 font-medium">Task</th>
            <th className="pr-6 py-1.5 font-medium text-right">Visits</th>
            <th className="pr-6 py-1.5 font-medium text-right">Labor</th>
            <th className="pr-6 py-1.5 font-medium text-right">Chems</th>
            <th className="pr-6 py-1.5 font-medium text-right">Expected</th>
            <th className="pr-6 py-1.5 font-medium text-right">ION invoice</th>
            <th className="py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {c.tasks.map((t) => (
            <tr key={t.id} className="border-b border-line-soft/30 last:border-0">
              <td className="pr-6 py-1.5 text-ink-dim">
                {t.service_name ?? "—"}
                <span className="ml-2 text-[10px] text-ink-mute">
                  {[t.category, t.frequency].filter(Boolean).join(" · ")}
                </span>
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">{t.visits}</td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">
                {cents(t.labor_cents)}
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">
                {cents(t.chem_cents)}
                {t.unpriced > 0 && (
                  <span className="ml-1 text-[10px] text-sun font-sans">
                    {t.unpriced} unpriced
                  </span>
                )}
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink">
                {cents(t.expected_cents)}
              </td>
              <td className="pr-6 py-1.5 text-right">
                <span className="font-mono num text-ink-dim">{cents(t.ion_cents)}</span>
                <span className="ml-1.5">
                  <Pill tone={ION_TONE[t.ion_match]}>
                    {t.ion_numbers ? `#${t.ion_numbers}` : t.ion_match}
                  </Pill>
                </span>
              </td>
              <td className="py-1.5">
                <Pill tone={STATUS_TONE[t.status]} dot>
                  {STATUS_LABEL[t.status]}
                </Pill>
                {t.needs_review_reason && (
                  <Pill tone="coral" className="ml-1">
                    {REASON_LABEL[t.needs_review_reason] ?? t.needs_review_reason}
                  </Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <StatusActions tasks={c.tasks} />

      {c.customer_id != null ? (
        <VisitCalendar customerId={c.customer_id} month={month} />
      ) : (
        <div className="text-[11px] text-ink-mute">
          No customer link — visit calendar unavailable.
        </div>
      )}
    </div>
  )
}

