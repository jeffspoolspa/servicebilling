"use client"

import { useState } from "react"
import { Pill } from "@/components/ui/pill"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils/format"
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
  segment: string
  office: string
  frequency: string
}

const ION_TONE = { match: "grass", mismatch: "coral", missing: "neutral" } as const
function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

/** Bills as the app DataTable: one expandable row per customer (click for the
 *  task breakdown + visit calendar), client-side sort/search/facets. */
export function BillsTable({
  customers,
  month,
}: {
  customers: CustomerBill[]
  month: string
}) {
  // $0 bills = QC-only task-months with no chemicals sold — nothing bills
  // out, but the visits still count. Hidden by default behind the banner.
  const [showZeros, setShowZeros] = useState(false)
  const zeros = customers.filter((c) => c.expected_cents === 0)
  const shown = showZeros ? customers : customers.filter((c) => c.expected_cents !== 0)

  const columns: ColumnDef<CustomerBill>[] = [
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => (
        <span className="text-ink">
          <span className="text-ink-mute mr-1.5 inline-block w-3">
            {row.getIsExpanded() ? "▾" : "▸"}
          </span>
          {row.original.name}
          {row.original.on_autopay && (
            <span className="ml-2 text-[10px] text-teal uppercase tracking-wide">autopay</span>
          )}
          {row.original.hold && (
            <Pill tone="coral" dot className="ml-2">
              hold
            </Pill>
          )}
        </span>
      ),
    },
    {
      id: "tasks",
      accessorFn: (r) => r.tasks.length,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tasks" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">{row.original.tasks.length}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "visits",
      accessorFn: (r) => r.visits,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Visits" />,
      cell: ({ row }) => <span className="font-mono num text-ink-dim">{row.original.visits}</span>,
      meta: { align: "right" },
    },
    {
      id: "labor",
      accessorFn: (r) => r.labor_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Labor" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">{cents(row.original.labor_cents)}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "chems",
      accessorFn: (r) => r.chem_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Chems" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">{cents(row.original.chem_cents)}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "expected",
      accessorFn: (r) => r.expected_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Expected" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink">{cents(row.original.expected_cents)}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "diff",
      accessorFn: (r) =>
        r.ion_cents == null ? -1 : Math.abs(r.ion_cents - r.expected_cents),
      header: ({ column }) => <DataTableColumnHeader column={column} title="ION diff" />,
      cell: ({ row }) => (
        <DiffCell
          ion_cents={row.original.ion_cents}
          expected_cents={row.original.expected_cents}
        />
      ),
      meta: { align: "right" },
    },
    {
      id: "docs",
      accessorFn: (r) => r.qbo_docs,
      header: () => <span>QBO</span>,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-ink-dim">{row.original.qbo_docs || "—"}</span>
      ),
      enableSorting: false,
    },
    // facet-only columns
    { id: "segment", accessorFn: (r) => r.segment, header: () => null },
    { id: "office", accessorFn: (r) => r.office, header: () => null },
    { id: "frequency", accessorFn: (r) => r.frequency, header: () => null },
  ]

  return (
    <div className="space-y-3">
      {zeros.length > 0 && (
        <button
          onClick={() => setShowZeros((v) => !v)}
          className="w-full text-left text-[11px] px-3.5 py-2 rounded-md border border-line bg-white/[0.02] text-ink-mute hover:text-ink transition-colors"
        >
          {showZeros ? "▾" : "▸"} {zeros.length} $0 bill{zeros.length === 1 ? "" : "s"}{" "}
          {showZeros ? "shown" : "hidden"} — quality-control visits with no chemicals
          sold; nothing bills out, visits still captured. Click to {showZeros ? "hide" : "show"}.
        </button>
      )}
    <DataTable
      columns={columns}
      data={shown}
      searchAccessor={(r) => `${r.name} ${r.qbo_docs}`}
      searchPlaceholder="Search customer or invoice…"
      facetFilters={[
        { columnId: "segment", label: "Type" },
        { columnId: "office", label: "Office" },
        { columnId: "frequency", label: "Frequency" },
      ]}
      columnVisibility={{ segment: false, office: false, frequency: false }}
      pageSize={25}
      initialSorting={[{ id: "name", desc: false }]}
      emptyText="No bills match this filter."
      renderSubRow={(row) => (
        <div className="px-6 py-4 bg-white/[0.015] border-b border-line-soft/40">
          <BillDetail c={row.original} month={month} />
        </div>
      )}
    />
    </div>
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
    return <span className="text-ink-mute">—</span>
  }
  const diff = ion_cents - expected_cents
  if (Math.abs(diff) <= 100) {
    return <span className="text-grass">✓</span>
  }
  return (
    <span className="font-mono num text-coral">
      {diff > 0 ? "+" : "−"}
      {formatCurrency(Math.abs(diff) / 100)}
    </span>
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

