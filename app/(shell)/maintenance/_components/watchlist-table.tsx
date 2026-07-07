"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Pill } from "@/components/ui/pill"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"

/** Fleet-wide pool watchlist (open maintenance.task_watchlist entries) on the
 *  maintenance dashboard: who's being watched, why, how urgently, and since
 *  when — with one-click resolve back to good. */

export interface WatchlistRow {
  id: number
  customer_id: number | null
  customer_name: string | null
  service_name: string | null
  reason: string
  reason_label: string
  priority: number
  source: string
  rule_key: string | null
  note: string | null
  opened_at: string
}

const PRIORITY = {
  1: { label: "P1 — act now", tone: "coral" as const },
  2: { label: "P2 — watching", tone: "sun" as const },
  3: { label: "P3 — note", tone: "neutral" as const },
}

const REASON_TONE: Record<string, "coral" | "sun" | "teal" | "neutral"> = {
  green_pool: "coral",
  equipment_down: "sun",
  low_chlorine: "sun",
  watch: "neutral",
}

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<number | null>(null)

  async function resolve(id: number) {
    setBusy(id)
    try {
      const r = await fetch("/api/maintenance-billing/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", id, note: "Resolved from dashboard" }),
      })
      if (r.ok) router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const columns: ColumnDef<WatchlistRow>[] = [
    {
      id: "customer",
      accessorFn: (r) => r.customer_name ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Pool" />,
      cell: ({ row }) => {
        const r = row.original
        return (
          <div>
            {r.customer_id ? (
              <Link
                href={`/maintenance/customers/${r.customer_id}` as never}
                className="text-ink hover:text-cyan"
              >
                {r.customer_name ?? `#${r.customer_id}`}
              </Link>
            ) : (
              <span className="text-ink">{r.customer_name ?? "—"}</span>
            )}
            {r.service_name && (
              <div className="font-mono text-[10px] text-ink-mute">{r.service_name}</div>
            )}
          </div>
        )
      },
    },
    {
      id: "reason",
      accessorFn: (r) => r.reason_label,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Reason" />,
      cell: ({ row }) => (
        <Pill tone={REASON_TONE[row.original.reason] ?? "neutral"} dot>
          {row.original.reason_label}
        </Pill>
      ),
    },
    {
      id: "priority",
      accessorFn: (r) => r.priority,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
      cell: ({ row }) => {
        const p = PRIORITY[row.original.priority as 1 | 2 | 3] ?? PRIORITY[2]
        return <Pill tone={p.tone}>{p.label}</Pill>
      },
    },
    {
      id: "source",
      accessorFn: (r) => (r.source === "rule" ? `rule: ${r.rule_key ?? "?"}` : "manual"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-ink-mute">
          {row.original.source === "rule" ? `rule: ${row.original.rule_key ?? "?"}` : "manual"}
        </span>
      ),
    },
    {
      id: "note",
      accessorFn: (r) => r.note ?? "",
      header: () => <span>Note</span>,
      cell: ({ row }) => (
        <span className="text-[12px] text-ink-dim block max-w-[320px] truncate" title={row.original.note ?? undefined}>
          {row.original.note ?? "—"}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "opened",
      accessorFn: (r) => r.opened_at,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Since" />,
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-ink-mute">
          {new Date(row.original.opened_at).toLocaleDateString("en-US", {
            month: "short", day: "numeric", timeZone: "America/New_York",
          })}
        </span>
      ),
    },
    {
      id: "actions",
      header: () => <span />,
      cell: ({ row }) => (
        <button
          onClick={() => resolve(row.original.id)}
          disabled={busy === row.original.id}
          className="text-[11px] px-2.5 py-1 rounded border border-grass/30 text-grass hover:bg-grass/10 disabled:opacity-50 whitespace-nowrap"
        >
          {busy === row.original.id ? "…" : "Resolve → good"}
        </button>
      ),
      enableSorting: false,
    },
  ]

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) => `${r.customer_name ?? ""} ${r.note ?? ""}`}
      facetFilters={[
        { columnId: "reason", label: "Reason" },
        { columnId: "priority", label: "Priority" },
        { columnId: "source", label: "Source" },
      ]}
      initialSorting={[{ id: "priority", desc: false }]}
      pageSize={10}
    />
  )
}
