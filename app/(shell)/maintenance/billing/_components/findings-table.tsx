"use client"

import { useMemo } from "react"
import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { groupFindings, type FindingGroup, type FindingRow } from "../_lib/findings"

/**
 * The audit's review queue, grouped by CUSTOMER-MONTH: a customer with four
 * flagged visits is one review, not four rows. Review opens the full-page
 * workbench (the sheet was retired — the day grid needs the width).
 */

export function FindingsTable({ rows }: { rows: FindingRow[] }) {
  const groups = useMemo(() => groupFindings(rows), [rows])

  const columns: ColumnDef<FindingGroup>[] = [
    {
      id: "customer",
      accessorFn: (g) => g.customerName,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.customerName}</span>,
    },
    {
      id: "month",
      accessorFn: (g) => g.month.slice(0, 7),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Month" />,
      cell: ({ row }) => <span className="font-mono text-xs text-ink-dim">{row.original.month.slice(0, 7)}</span>,
    },
    {
      id: "visits",
      accessorFn: (g) => g.findings.length,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Flagged" />,
      cell: ({ row }) => (
        <Pill tone="sun">
          {row.original.findings.length} visit{row.original.findings.length === 1 ? "" : "s"}
        </Pill>
      ),
      meta: { align: "right" },
    },
    {
      id: "amount",
      accessorFn: (g) => g.totalCents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Flagged $" />,
      cell: ({ row }) => <span className="font-mono num">{formatCurrency(row.original.totalCents / 100)}</span>,
      meta: { align: "right" },
    },
    {
      id: "status",
      accessorFn: (g) => (g.openIds.length > 0 ? "Open" : "Reviewed"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) =>
        row.original.openIds.length > 0 ? (
          <Pill tone="coral">Open</Pill>
        ) : (
          <span title={row.original.resolvedBy ?? undefined}>
            <Pill tone="grass">Reviewed</Pill>
          </span>
        ),
    },
    {
      id: "actions",
      header: () => <span>Action</span>,
      cell: ({ row }) => (
        <Link
          href={`/maintenance/billing/findings/${row.original.customerId}?month=${row.original.month.slice(0, 7)}` as never}
          className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10 whitespace-nowrap"
        >
          {row.original.openIds.length > 0 ? "Review" : "View"}
        </Link>
      ),
      enableSorting: false,
    },
  ]

  const monthOptions = [...new Set(groups.map((g) => g.month.slice(0, 7)))]
    .sort()
    .reverse()
    .map((v) => ({ value: v, label: v }))

  return (
    <DataTable
      columns={columns}
      data={groups}
      searchAccessor={(g) => `${g.customerName} ${g.customerId}`}
      searchPlaceholder="Search customer…"
      facetFilters={[
        { columnId: "month", label: "Month", options: monthOptions },
        { columnId: "status", label: "Status", options: [{ value: "Open", label: "Open" }, { value: "Reviewed", label: "Reviewed" }] },
      ]}
      pageSize={25}
      initialSorting={[{ id: "amount", desc: true }]}
      emptyText="No findings — the audit has nothing to say."
    />
  )
}
