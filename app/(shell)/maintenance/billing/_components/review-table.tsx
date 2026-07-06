"use client"

import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { Pill } from "@/components/ui/pill"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils/format"
import { REASON_LABEL } from "../_lib/status"
import { ReviewSheet, type ReviewSheetRow } from "./review-sheet"
import { ReviewQueueActions } from "./review-queue-actions"

/** Needs Review as the app DataTable: one uniform row per held customer,
 *  reason pills + x-median chip, the Review sheet and release actions. */

export interface ReviewRow extends ReviewSheetRow {
  qbo_docs: string
}

export function ReviewTable({ rows }: { rows: ReviewRow[] }) {
  const columns: ColumnDef<ReviewRow>[] = [
    {
      id: "customer",
      accessorFn: (r) => r.name,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.name}</span>,
    },
    {
      id: "reason",
      accessorFn: (r) => r.reasons.map((x) => REASON_LABEL[x] ?? x).join(", "),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 flex-wrap">
          {row.original.reasons.map((reason) => (
            <Pill key={reason} tone="coral">
              {REASON_LABEL[reason] ?? reason}
            </Pill>
          ))}
          {row.original.chem && <Pill tone="sun">{row.original.chem.x_median}x median</Pill>}
        </div>
      ),
      filterFn: (row, _id, value) =>
        row.original.reasons.some((x) => (REASON_LABEL[x] ?? x) === value),
    },
    {
      id: "expected",
      accessorFn: (r) => r.expected,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Expected" />,
      cell: ({ row }) => (
        <span className="font-mono num">{formatCurrency(row.original.expected / 100)}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "ion",
      accessorFn: (r) => r.ion ?? 0,
      header: ({ column }) => <DataTableColumnHeader column={column} title="ION" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">
          {row.original.ion == null ? "—" : formatCurrency(row.original.ion / 100)}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "qbo",
      accessorFn: (r) => r.qbo_total,
      header: ({ column }) => <DataTableColumnHeader column={column} title="QBO" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">
          {row.original.qbo_total > 0 ? formatCurrency(row.original.qbo_total / 100) : "—"}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "docs",
      accessorFn: (r) => r.qbo_docs,
      header: () => <span>Docs</span>,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-ink-dim">{row.original.qbo_docs || "—"}</span>
      ),
      enableSorting: false,
    },
    {
      id: "actions",
      header: () => <span>Action</span>,
      cell: ({ row }) => {
        const r = row.original
        return (
          <span className="inline-flex items-center gap-2">
            <ReviewSheet row={r} />
            {r.chemFlagged ? (
              <Link
                href={`/maintenance/billing/review/${r.customer_id}?month=${r.month}` as never}
                className="text-[11px] px-2.5 py-1 rounded border border-coral/30 text-coral hover:bg-coral/10 whitespace-nowrap"
              >
                Chems →
              </Link>
            ) : (
              <ReviewQueueActions ids={r.ids} />
            )}
          </span>
        )
      },
      enableSorting: false,
    },
  ]

  const reasonOptions = [
    ...new Set(rows.flatMap((r) => r.reasons.map((x) => REASON_LABEL[x] ?? x))),
  ]
    .sort()
    .map((v) => ({ value: v, label: v }))

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.name} ${r.qbo_docs}`}
      searchPlaceholder="Search customer or invoice…"
      facetFilters={[{ columnId: "reason", label: "Reason", options: reasonOptions }]}
      pageSize={25}
      initialSorting={[{ id: "customer", desc: false }]}
      emptyText="Nothing held for review."
    />
  )
}
