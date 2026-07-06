"use client"

import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { Pill } from "@/components/ui/pill"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils/format"
import type { BillingPeriodRow } from "../_lib/queries"

/** Processed periods as the app DataTable: per-period rows with the invoice
 *  link, paid state, and how it resolved (charged / emailed / manual). */

function method(r: BillingPeriodRow): string {
  return r.autopay_charged ? "charged" : r.invoice_sent ? "emailed" : "manual"
}

export function ProcessedTable({ rows, month }: { rows: BillingPeriodRow[]; month: string }) {
  const columns: ColumnDef<BillingPeriodRow>[] = [
    {
      id: "customer",
      accessorFn: (r) => r.customer_name ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.customer_name ?? "—"}</span>,
    },
    {
      id: "invoice",
      accessorFn: (r) => r.qbo_doc_number ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Invoice" />,
      cell: ({ row }) =>
        row.original.qbo_doc_number ? (
          <Link
            href={`/maintenance/billing/period/${row.original.id}?month=${month}` as never}
            className="text-cyan hover:underline font-mono text-xs"
          >
            #{row.original.qbo_doc_number}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      id: "amount",
      accessorFn: (r) => r.qbo_total ?? 0,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
      cell: ({ row }) => (
        <span className="font-mono num">
          {row.original.qbo_total != null ? formatCurrency(Number(row.original.qbo_total)) : "—"}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "balance",
      accessorFn: (r) => r.qbo_balance ?? 0,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Balance" />,
      cell: ({ row }) => {
        const b = row.original.qbo_balance
        if (b == null) return "—"
        return Number(b) <= 0 ? (
          <Pill tone="grass" dot>
            paid
          </Pill>
        ) : (
          <span className="font-mono num text-sun">{formatCurrency(Number(b))}</span>
        )
      },
      meta: { align: "right" },
    },
    {
      id: "sent",
      accessorFn: (r) => (r.invoice_sent ? 1 : 0),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Sent" />,
      cell: ({ row }) =>
        row.original.invoice_sent ? (
          <span className="text-teal">✓</span>
        ) : (
          <span className="text-ink-mute">—</span>
        ),
    },
    {
      id: "method",
      accessorFn: (r) => method(r),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Method" />,
      cell: ({ row }) => <span className="text-ink-dim">{method(row.original)}</span>,
    },
    // facet-only columns
    { id: "segment", accessorFn: (r) => r.segment ?? "", header: () => null },
    {
      id: "office",
      accessorFn: (r) => (r.office ?? "").replace(", GA", ""),
      header: () => null,
    },
    { id: "frequency", accessorFn: (r) => r.frequency ?? "", header: () => null },
  ]

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.customer_name ?? ""} ${r.qbo_doc_number ?? ""}`}
      searchPlaceholder="Search customer or invoice…"
      facetFilters={[
        { columnId: "segment", label: "Type" },
        { columnId: "office", label: "Office" },
        { columnId: "frequency", label: "Frequency" },
      ]}
      columnVisibility={{ segment: false, office: false, frequency: false }}
      pageSize={25}
      initialSorting={[{ id: "customer", desc: false }]}
      emptyText="Nothing processed yet."
    />
  )
}
