"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { Pill } from "@/components/ui/pill"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import type { AutopayCustomerRow } from "../_lib/queries"
import { AutopayAdd, RosterRowActions } from "./autopay-manage"

/** Autopay roster as the app DataTable: search, sortable columns, add /
 *  change / remove actions. Data comes from the server page. */

const STATUS_TONE: Record<string, "grass" | "coral" | "sun" | "neutral"> = {
  good: "grass",
  declined: "coral",
  hold: "sun",
  payment_issue: "sun",
}

function pmString(r: AutopayCustomerRow): string {
  return r.payment_method === "ach"
    ? "ACH"
    : `${r.card_type ?? "card"} ····${r.last_four ?? "?"}`
}

const columns: ColumnDef<AutopayCustomerRow>[] = [
  {
    id: "customer",
    accessorFn: (r) => r.customer_name ?? "",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
    cell: ({ row }) => <span className="text-ink">{row.original.customer_name ?? "—"}</span>,
  },
  {
    id: "method",
    accessorFn: (r) => pmString(r),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Payment method" />,
    cell: ({ row }) => <span className="text-ink-dim">{pmString(row.original)}</span>,
  },
  {
    id: "email",
    accessorFn: (r) => r.email ?? "",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
    cell: ({ row }) => (
      <span className="text-ink-mute text-[11px]">{row.original.email ?? "—"}</span>
    ),
  },
  {
    id: "status",
    accessorFn: (r) => r.payment_status ?? "unknown",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Pill tone={STATUS_TONE[row.original.payment_status ?? ""] ?? "neutral"} dot>
        {row.original.payment_status ?? "unknown"}
      </Pill>
    ),
  },
  {
    id: "declines",
    accessorFn: (r) => r.consecutive_declines ?? 0,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Declines" />,
    cell: ({ row }) => (
      <span className="font-mono num text-ink-dim">
        {row.original.consecutive_declines ?? 0}
      </span>
    ),
    meta: { align: "right" },
  },
  {
    id: "actions",
    header: () => <span className="block text-right">Actions</span>,
    cell: ({ row }) => (
      <div className="text-right">
        <RosterRowActions qboCustomerId={row.original.qbo_customer_id} />
      </div>
    ),
    enableSorting: false,
  },
]

export function AutopayTable({
  rows,
  candidates,
}: {
  rows: AutopayCustomerRow[]
  candidates: { qbo_customer_id: string; display_name: string }[]
}) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.customer_name ?? ""} ${r.email ?? ""}`}
      searchPlaceholder="Search customer…"
      facetFilters={[{ columnId: "status", label: "Status" }]}
      toolbarExtra={<AutopayAdd candidates={candidates} />}
      pageSize={25}
      initialSorting={[{ id: "customer", desc: false }]}
      emptyText="No autopay enrollments."
    />
  )
}
