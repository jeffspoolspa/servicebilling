"use client"

import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { StatusStepper } from "@/components/ui/status-stepper"
import { formatCurrency } from "@/lib/utils/format"
import { MONTH_STAGES, stepperStage, type MonthOverviewRow } from "../_lib/months"

/**
 * One table, every journey: the progression stepper shows where each
 * customer-month sits; pauses (disputed, held) show as pills on their
 * stage. Filter by status, click through to the stage detail.
 */

const PAUSE_TONE: Record<string, "coral" | "sun"> = { disputed: "coral", held: "sun" }

export function MonthsTable({ rows }: { rows: MonthOverviewRow[] }) {
  const columns: ColumnDef<MonthOverviewRow>[] = [
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
      id: "progress",
      accessorFn: (r) => r.status,
      header: () => <span>Progression</span>,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(row.original.status)} className="max-w-[420px]" />
          {row.original.status === "disputed" && <Pill tone={PAUSE_TONE.disputed}>disputed</Pill>}
          {row.original.status === "held" && <Pill tone={PAUSE_TONE.held}>held</Pill>}
        </div>
      ),
      enableSorting: false,
    },
    {
      id: "status",
      accessorFn: (r) => r.status,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <span className="font-mono text-xs text-ink-dim">{row.original.status}</span>,
    },
    {
      id: "flags",
      accessorFn: (r) => r.open_findings,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Flags" />,
      cell: ({ row }) =>
        row.original.open_findings > 0 ? <Pill tone="sun">{row.original.open_findings}</Pill> : <span className="text-ink-mute">—</span>,
      meta: { align: "right" },
    },
    {
      id: "subtotal",
      accessorFn: (r) => r.subtotal_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Subtotal" />,
      cell: ({ row }) => <span className="font-mono num">{formatCurrency(row.original.subtotal_cents / 100)}</span>,
      meta: { align: "right" },
    },
    {
      id: "actions",
      header: () => <span>Detail</span>,
      cell: ({ row }) => (
        <Link
          href={`/maintenance/billing/months/${row.original.id}` as never}
          className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10 whitespace-nowrap"
        >
          Open
        </Link>
      ),
      enableSorting: false,
    },
  ]

  const monthOptions = [...new Set(rows.map((r) => r.month.slice(0, 7)))]
    .sort()
    .reverse()
    .map((v) => ({ value: v, label: v }))
  const statusOptions = ["accruing", "reconciled", "disputed", "gated", "held", "invoiced", "closed"].map((v) => ({
    value: v,
    label: v,
  }))

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.customer_name ?? ""} ${r.customer_id}`}
      searchPlaceholder="Search customer…"
      facetFilters={[
        { columnId: "month", label: "Month", options: monthOptions },
        { columnId: "status", label: "Status", options: statusOptions },
      ]}
      pageSize={50}
      initialSorting={[{ id: "subtotal", desc: true }]}
      emptyText="No billing months yet."
    />
  )
}
