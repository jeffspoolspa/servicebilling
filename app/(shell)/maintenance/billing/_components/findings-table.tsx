"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { Sheet } from "@/components/ui/sheet"
import { formatCurrency } from "@/lib/utils/format"

/**
 * The audit's findings as the app DataTable: rule pills, the finding's
 * sentence, and a review sheet where the resolution (mandatory reason) is
 * written. Resolving re-enqueues the month so the gate re-runs with the
 * finding cleared.
 */

export interface FindingRow {
  id: string
  billing_month_id: string
  month: string
  customer_id: number
  customer_name: string | null
  phase: string
  rule: string
  severity: string
  message: string
  cents: number | null
  detected_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  month_invoiced: boolean
}

const RULE_LABEL: Record<string, string> = {
  cpv_outlier: "Chem outlier",
  bulk_item_misbill: "Bulk mis-bill",
  chems_billed_to_provider: "Chems billed to provider",
}
const RULE_TONE: Record<string, "coral" | "sun" | "indigo"> = {
  cpv_outlier: "sun",
  bulk_item_misbill: "coral",
  chems_billed_to_provider: "indigo",
}

function ReviewFindingSheet({ row, onDone }: { row: FindingRow; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resolve = async () => {
    setBusy(true)
    setError(null)
    const res = await fetch("/api/billing/findings/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, resolution }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? `failed (${res.status})`)
      return
    }
    setOpen(false)
    onDone()
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10 whitespace-nowrap"
      >
        Review
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={row.customer_name ?? `Customer ${row.customer_id}`}>
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <Pill tone={RULE_TONE[row.rule] ?? "coral"}>{RULE_LABEL[row.rule] ?? row.rule}</Pill>
            <span className="text-ink-dim">{row.month.slice(0, 7)}</span>
            {row.cents != null && <span className="font-mono num">{formatCurrency(row.cents / 100)}</span>}
            {row.month_invoiced && <Pill tone="neutral">month invoiced</Pill>}
          </div>
          <p className="text-ink leading-relaxed">{row.message}</p>
          <div className="space-y-2">
            <label className="block text-xs text-ink-mute">
              Resolution — what was decided and why (required)
            </label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={3}
              placeholder="e.g. verified with tech: genuine algae treatment, bill stands / mis-key confirmed, visit corrected in ION"
              className="w-full rounded border border-line-soft bg-transparent px-2.5 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:border-cyan/50"
            />
            {error && <p className="text-xs text-coral">{error}</p>}
            <button
              onClick={resolve}
              disabled={busy || !resolution.trim()}
              className="text-[12px] px-3 py-1.5 rounded border border-cyan/40 text-cyan hover:bg-cyan/10 disabled:opacity-40"
            >
              {busy ? "Saving" : "Mark reviewed"}
            </button>
            <p className="text-[11px] text-ink-mute">
              Marking reviewed re-queues the month; the gate re-runs with this finding cleared.
            </p>
          </div>
        </div>
      </Sheet>
    </>
  )
}

export function FindingsTable({ rows }: { rows: FindingRow[] }) {
  const router = useRouter()
  const columns: ColumnDef<FindingRow>[] = [
    {
      id: "customer",
      accessorFn: (r) => r.customer_name ?? String(r.customer_id),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.customer_name ?? row.original.customer_id}</span>,
    },
    {
      id: "month",
      accessorFn: (r) => r.month.slice(0, 7),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Month" />,
      cell: ({ row }) => <span className="font-mono text-xs text-ink-dim">{row.original.month.slice(0, 7)}</span>,
    },
    {
      id: "rule",
      accessorFn: (r) => RULE_LABEL[r.rule] ?? r.rule,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Rule" />,
      cell: ({ row }) => (
        <Pill tone={RULE_TONE[row.original.rule] ?? "coral"}>
          {RULE_LABEL[row.original.rule] ?? row.original.rule}
        </Pill>
      ),
    },
    {
      id: "finding",
      accessorFn: (r) => r.message,
      header: () => <span>Finding</span>,
      cell: ({ row }) => (
        <span className="text-xs text-ink-dim block max-w-[520px] truncate" title={row.original.message}>
          {row.original.message}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "amount",
      accessorFn: (r) => r.cents ?? 0,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
      cell: ({ row }) => (
        <span className="font-mono num">
          {row.original.cents == null ? "—" : formatCurrency(row.original.cents / 100)}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "status",
      accessorFn: (r) => (r.resolved_at ? "Reviewed" : "Open"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) =>
        row.original.resolved_at ? (
          <span title={`${row.original.resolved_by ?? ""}: ${row.original.resolution ?? ""}`}>
            <Pill tone="grass">Reviewed</Pill>
          </span>
        ) : (
          <Pill tone="coral">Open</Pill>
        ),
    },
    {
      id: "actions",
      header: () => <span>Action</span>,
      cell: ({ row }) =>
        row.original.resolved_at ? (
          <span className="text-[11px] text-ink-mute">{row.original.resolved_by}</span>
        ) : (
          <ReviewFindingSheet row={row.original} onDone={() => router.refresh()} />
        ),
      enableSorting: false,
    },
  ]

  const ruleOptions = [...new Set(rows.map((r) => RULE_LABEL[r.rule] ?? r.rule))]
    .sort()
    .map((v) => ({ value: v, label: v }))
  const monthOptions = [...new Set(rows.map((r) => r.month.slice(0, 7)))]
    .sort()
    .reverse()
    .map((v) => ({ value: v, label: v }))

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.customer_name ?? ""} ${r.customer_id} ${r.message}`}
      searchPlaceholder="Search customer or finding…"
      facetFilters={[
        { columnId: "rule", label: "Rule", options: ruleOptions },
        { columnId: "month", label: "Month", options: monthOptions },
        { columnId: "status", label: "Status", options: [{ value: "Open", label: "Open" }, { value: "Reviewed", label: "Reviewed" }] },
      ]}
      pageSize={25}
      initialSorting={[{ id: "amount", desc: true }]}
      emptyText="No findings — the audit has nothing to say."
    />
  )
}
