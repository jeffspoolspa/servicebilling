"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { cn } from "@/lib/utils/cn"
import { formatCurrency } from "@/lib/utils/format"
import { displayStatus, MONTH_DISPLAY_STATUSES, type MonthDisplayStatus, type MonthOverviewRow } from "../_lib/months"

/**
 * One table, every journey — one row per customer for the picked month
 * (the month filter lives on the page, so no month column here). The
 * STATUS pill is the whole story: pre-invoice in-progress / held /
 * unreconciled, post-invoice the documents speak (issued / open / closed).
 * The status filter is a visible button row, never a dropdown.
 */

const STATUS_TONE: Record<MonthDisplayStatus, "neutral" | "cyan" | "teal" | "sun" | "coral" | "grass"> = {
  "in-progress": "neutral",
  held: "sun",
  unreconciled: "coral",
  issued: "cyan",
  open: "teal",
  closed: "grass",
}

export function MonthsTable({ rows }: { rows: MonthOverviewRow[] }) {
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState<MonthDisplayStatus | null>(null)
  const [selected, setSelected] = useState<(MonthOverviewRow & { display: MonthDisplayStatus })[]>([])
  const [tableEpoch, setTableEpoch] = useState(0)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)

  const bulk = async (action: "review" | "advance") => {
    setBulkBusy(action)
    setBulkMsg(null)
    try {
      const r = await fetch("/api/billing/months/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, month_ids: selected.map((m) => m.id) }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(String(j.error ?? `HTTP ${r.status}`))
      setBulkMsg(
        action === "review"
          ? `${j.reviewed} flag${j.reviewed === 1 ? "" : "s"} reviewed across ${j.months} months`
          : `advanced ${j.months?.claimed ?? 0} month command${(j.months?.claimed ?? 0) === 1 ? "" : "s"}, ${j.invoices?.advanced ?? 0} invoice step${(j.invoices?.advanced ?? 0) === 1 ? "" : "s"}`,
      )
      setSelected([])
      setTableEpoch((e) => e + 1) // remount clears the checkbox state
      router.refresh()
    } catch (e) {
      setBulkMsg(`failed: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`)
    } finally {
      setBulkBusy(null)
    }
  }

  const withStatus = useMemo(() => rows.map((r) => ({ ...r, display: displayStatus(r) })), [rows])
  const counts = useMemo(() => {
    const c = new Map<MonthDisplayStatus, number>()
    for (const r of withStatus) c.set(r.display, (c.get(r.display) ?? 0) + 1)
    return c
  }, [withStatus])
  const shown = statusFilter ? withStatus.filter((r) => r.display === statusFilter) : withStatus

  const columns: ColumnDef<MonthOverviewRow & { display: MonthDisplayStatus }>[] = [
    {
      id: "select",
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          ref={(el) => { if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected() }}
          onChange={(e) => table.toggleAllPageRowsSelected(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 accent-cyan-500 cursor-pointer"
          aria-label="Select page"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 accent-cyan-500 cursor-pointer"
          aria-label="Select row"
        />
      ),
      enableSorting: false,
      meta: { widthClass: "w-8" },
    },
    {
      id: "customer",
      accessorFn: (r) => r.customer_name ?? String(r.customer_id),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.customer_name ?? row.original.customer_id}</span>,
    },
    {
      id: "status",
      accessorFn: (r) => r.display,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <Pill tone={STATUS_TONE[row.original.display]}>{row.original.display}</Pill>,
    },
    {
      id: "invoices",
      header: () => <span>Invoices</span>,
      cell: ({ row }) => {
        const inv = row.original.issued_invoices ?? []
        if (inv.length === 0) return <Pill tone="neutral">draft</Pill>
        return (
          <div className="flex flex-wrap gap-1">
            {inv.map((i) => {
              // grey draft · blue built-not-sent · orange open balance · green paid
              const tone = i.email_status !== "EmailSent" ? "cyan" : (i.balance ?? 0) > 0 ? "sun" : "grass"
              const state = i.email_status !== "EmailSent" ? "not sent" : (i.balance ?? 0) > 0 ? `owes ${formatCurrency(Number(i.balance))}` : "paid"
              return (
                <Pill key={i.qbo_invoice_id} tone={tone} title={`${i.doc_number} — ${state}`}>
                  <span className="font-mono">{i.doc_number}</span>
                </Pill>
              )
            })}
          </div>
        )
      },
      enableSorting: false,
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
  ]

  // dashboard-01's tabs-style segmented filter, inline with the search box
  const filterTabs = (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-white/[0.04] p-0.5">
      {[null, ...MONTH_DISPLAY_STATUSES].map((s) => {
        const active = statusFilter === s
        const count = s === null ? withStatus.length : (counts.get(s) ?? 0)
        return (
          <button
            key={s ?? "all"}
            onClick={() => setStatusFilter(active ? null : s)}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-[12px] transition-colors",
              active ? "bg-bg-elev text-ink border border-line shadow-sm" : "text-ink-dim hover:text-ink",
            )}
          >
            {s ?? "All"}
            <span className={cn("text-[10.5px] font-mono tabular-nums", active ? "text-ink-dim" : "text-ink-mute")}>{count}</span>
          </button>
        )
      })}
    </div>
  )

  const parkedDeclines = selected.filter((m) => m.display === "issued").length
  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cyan/30 bg-cyan/[0.06] px-3 py-1.5 text-[12px]">
          <span className="text-ink">{selected.length} selected</span>
          <button
            onClick={() => bulk("review")}
            disabled={bulkBusy !== null}
            className="h-7 px-3 rounded-md border border-line bg-bg-elev text-ink-dim hover:border-sun hover:text-sun disabled:opacity-50"
          >
            {bulkBusy === "review" ? "Reviewing…" : "Mark flags reviewed"}
          </button>
          <button
            onClick={() => bulk("advance")}
            disabled={bulkBusy !== null}
            className="h-7 px-3 rounded-md border border-line bg-bg-elev text-ink-dim hover:border-cyan hover:text-cyan disabled:opacity-50"
          >
            {bulkBusy === "advance" ? "Running…" : "Issue"}
          </button>
          <button
            disabled
            title="the decline-email sender still reads the legacy autopay table — being adapted to the machine's declines"
            className="h-7 px-3 rounded-md border border-line text-ink-mute opacity-50 cursor-not-allowed"
          >
            Send decline emails{parkedDeclines > 0 ? ` (${parkedDeclines})` : ""}
          </button>
        </div>
      )}
      {bulkMsg && <div className="text-[11.5px] text-ink-dim">{bulkMsg}</div>}
      <DataTable
        key={tableEpoch}
        columns={columns}
        data={shown}
        searchAccessor={(r) => `${r.customer_name ?? ""} ${r.customer_id}`}
        searchPlaceholder="Search customer…"
        toolbarExtra={filterTabs}
        pageSize={25}
        initialSorting={[{ id: "subtotal", desc: true }]}
        onRowClick={(r) => router.push(`/maintenance/billing/months/${r.id}` as never)}
        onSelectionChange={setSelected}
        emptyText="No billing months match."
      />
    </div>
  )
}
