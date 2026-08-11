"use client"

import { useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { TicketSheet } from "./ticket-sheet"
import { NewTicketSheet } from "./new-ticket-sheet"
import { channelLabel } from "../_lib/labels"
import type { TicketRow } from "../_lib/views"

/** Priority is the queue's first sort, so it reads as colour before text. */
const PRIORITY_TONE = {
  Critical: "coral",
  High: "sun",
  Medium: "cyan",
  Low: "neutral",
} as const

const AGE = (days: number) =>
  days < 1 ? "today" : days < 2 ? "yesterday" : `${Math.floor(days)}d`

export function TicketsTable({ rows }: { rows: TicketRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const columns: ColumnDef<TicketRow>[] = [
    {
      accessorKey: "customer",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => (
        <span className="text-ink-dim">{row.original.customer ?? "(unknown)"}</span>
      ),
    },
    {
      accessorKey: "subject",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Subject" />,
      cell: ({ row }) => <span className="text-ink">{row.original.subject}</span>,
    },
    {
      accessorKey: "priority",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
      cell: ({ row }) => (
        <Pill tone={PRIORITY_TONE[row.original.priority] ?? "neutral"}>{row.original.priority}</Pill>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => (
        <Pill tone={row.original.status === "Open" ? "cyan" : "neutral"}>{row.original.status}</Pill>
      ),
    },
    {
      accessorKey: "channel",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Channel" />,
      cell: ({ row }) => (
        <span className="text-ink-mute">{channelLabel(row.original.channel)}</span>
      ),
    },
    {
      accessorKey: "age_days",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Age" />,
      cell: ({ row }) => <span className="text-ink-mute">{AGE(row.original.age_days)}</span>,
    },
    {
      accessorKey: "last_note",
      header: "Last note",
      cell: ({ row }) => (
        <span className="text-ink-mute line-clamp-1">{row.original.last_note ?? "—"}</span>
      ),
    },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        searchAccessor={(row) =>
          `${row.customer ?? ""} ${row.subject} ${row.last_note ?? ""} ${row.opened_by}`}
        searchPlaceholder="Search customer, subject, note…"
        facetFilters={[
          { columnId: "status", label: "Status" },
          { columnId: "priority", label: "Priority" },
        ]}
        toolbarExtra={
          <button
            className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5
                       text-[10.5px] font-medium text-emerald-300 hover:bg-emerald-500/20"
            onClick={() => setCreating(true)}
          >
            Open ticket
          </button>
        }
        initialSorting={[{ id: "age_days", desc: false }]}
        emptyText="No tickets yet."
        onRowClick={(row) => setOpenId(row.ticket_id)}
      />

      {openId && <TicketSheet ticketId={openId} onClose={() => setOpenId(null)} />}
      {creating && (
        <NewTicketSheet
          onClose={() => setCreating(false)}
          // Straight into the ticket: the caller is usually still talking, and
          // hunting for the row you just made to add the next note is the
          // friction this removes.
          onCreated={(ticketId) => { setCreating(false); setOpenId(ticketId) }}
        />
      )}
    </>
  )
}
