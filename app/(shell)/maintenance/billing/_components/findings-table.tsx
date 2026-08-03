"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Pill } from "@/components/ui/pill"
import { Sheet } from "@/components/ui/sheet"
import { formatCurrency } from "@/lib/utils/format"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { cn } from "@/lib/utils/cn"

/**
 * The audit's findings as the app DataTable, with the review flow built for
 * throughput: the sheet shows the finding NEXT TO its evidence — the month's
 * visits from the published read model (maint_billing_review_visits: tech,
 * readings, chems), flagged visit first — and resolving one auto-advances to
 * the next open finding, so a queue of flags is a single sitting.
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
}

interface ReviewVisit {
  visit_id: string
  visit_date: string
  service_name: string | null
  body: string | null
  tech: string | null
  minutes: number | null
  notes: string | null
  readings: Record<string, string>
  chems: { item: string; qty: number; cents: number | null; category: string | null }[]
}

function VisitCard({ v, flagged }: { v: ReviewVisit; flagged: boolean }) {
  const chemTotal = v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
  return (
    <div className={cn("rounded border px-3 py-2.5 space-y-2", flagged ? "border-coral/40 bg-coral/5" : "border-line-soft")}>
      <div className="flex items-center gap-2 text-xs">
        {flagged && <Pill tone="coral">flagged</Pill>}
        <span className="font-mono text-ink">{v.visit_date}</span>
        <span className="text-ink-dim">{v.tech ?? "—"}</span>
        {v.minutes != null && <span className="text-ink-mute">{v.minutes}m</span>}
        {v.body && <span className="text-ink-mute">{v.body}</span>}
        <span className="ml-auto font-mono num text-ink">{formatCurrency(chemTotal / 100)}</span>
      </div>
      {v.chems.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {v.chems.map((c, i) => (
              <tr key={i} className="text-ink-dim">
                <td className="py-0.5">{c.item}</td>
                <td className="py-0.5 text-right font-mono">{c.qty}</td>
                <td className="py-0.5 text-right font-mono w-20">{c.cents == null ? "—" : formatCurrency(c.cents / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {Object.keys(v.readings ?? {}).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(v.readings).map(([name, value]) => (
            <span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-ink-mute border border-line-soft">
              {name} <span className="text-ink-dim font-mono">{value}</span>
            </span>
          ))}
        </div>
      )}
      {v.notes && <p className="text-[11px] text-ink-mute leading-snug">{v.notes}</p>}
    </div>
  )
}

function FindingReviewSheet({
  row,
  position,
  onClose,
  onResolved,
}: {
  row: FindingRow
  position: { index: number; total: number }
  onClose: () => void
  onResolved: () => void
}) {
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visits, setVisits] = useState<ReviewVisit[] | null>(null)

  // The evidence: the month's visits from the published read model.
  useEffect(() => {
    setVisits(null)
    setResolution("")
    setError(null)
    const sb = createSupabaseBrowser()
    sb.rpc("maint_billing_review_visits", { p_customer_id: row.customer_id, p_month: row.month })
      .then(({ data, error: e }) => {
        if (e) setError(e.message)
        else setVisits((data ?? []) as ReviewVisit[])
      })
  }, [row.id, row.customer_id, row.month])

  const flaggedDate = /^\d{4}-\d{2}-\d{2}/.test(row.message) ? row.message.slice(0, 10) : null
  const ordered = useMemo(() => {
    const all = visits ?? []
    if (!flaggedDate) return all
    return [...all].sort((a, b) => Number(b.visit_date === flaggedDate) - Number(a.visit_date === flaggedDate))
  }, [visits, flaggedDate])

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
    onResolved()
  }

  return (
    <Sheet open onClose={onClose} title={row.customer_name ?? `Customer ${row.customer_id}`}>
      <div className="space-y-4 text-sm pb-8">
        <div className="flex items-center gap-2">
          <Pill tone="sun">{RULE_LABEL[row.rule] ?? row.rule}</Pill>
          <span className="text-ink-dim">{row.month.slice(0, 7)}</span>
          {row.cents != null && <span className="font-mono num">{formatCurrency(row.cents / 100)}</span>}
          {row.month_invoiced && <Pill tone="neutral">month invoiced</Pill>}
          <span className="ml-auto text-[11px] text-ink-mute">
            {position.index + 1} of {position.total} open
          </span>
        </div>
        <p className="text-ink leading-relaxed">{row.message}</p>

        <div className="space-y-2">
          <label className="block text-xs text-ink-mute">
            Resolution — what was decided and why (required)
          </label>
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={2}
            placeholder="e.g. verified with tech: genuine algae treatment, bill stands / mis-key confirmed, visit corrected in ION"
            className="w-full rounded border border-line-soft bg-transparent px-2.5 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:border-cyan/50"
          />
          {error && <p className="text-xs text-coral">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={resolve}
              disabled={busy || !resolution.trim()}
              className="text-[12px] px-3 py-1.5 rounded border border-cyan/40 text-cyan hover:bg-cyan/10 disabled:opacity-40"
            >
              {busy ? "Saving" : "Mark reviewed"}
            </button>
            <span className="text-[11px] text-ink-mute">Saves, re-queues the month, and opens the next open finding.</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-ink-mute">
            {visits === null ? "Loading visits…" : `${visits.length} visit(s) this month${flaggedDate ? " — flagged first" : ""}`}
          </div>
          {ordered.map((v) => (
            <VisitCard key={v.visit_id} v={v} flagged={v.visit_date === flaggedDate} />
          ))}
        </div>
      </div>
    </Sheet>
  )
}

export function FindingsTable({ rows }: { rows: FindingRow[] }) {
  const router = useRouter()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [resolvedLocally, setResolvedLocally] = useState<Set<string>>(new Set())

  // The review queue: open findings in the table's default order (amount
  // desc) — resolving walks this list without round-tripping the server.
  const queue = useMemo(
    () => rows.filter((r) => !r.resolved_at).sort((a, b) => (b.cents ?? 0) - (a.cents ?? 0)),
    [rows],
  )
  const openQueue = queue.filter((r) => !resolvedLocally.has(r.id))
  const active = openQueue.find((r) => r.id === activeId) ?? null

  const advance = () => {
    if (!active) return
    const i = openQueue.findIndex((r) => r.id === active.id)
    const next = openQueue[i + 1] ?? null
    setResolvedLocally((s) => new Set(s).add(active.id))
    setActiveId(next?.id ?? null)
    router.refresh()
  }

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
      cell: ({ row }) => <Pill tone="sun">{RULE_LABEL[row.original.rule] ?? row.original.rule}</Pill>,
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
      accessorFn: (r) => (r.resolved_at || resolvedLocally.has(r.id) ? "Reviewed" : "Open"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) =>
        row.original.resolved_at || resolvedLocally.has(row.original.id) ? (
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
        row.original.resolved_at || resolvedLocally.has(row.original.id) ? (
          <span className="text-[11px] text-ink-mute">{row.original.resolved_by ?? "reviewed"}</span>
        ) : (
          <button
            onClick={() => setActiveId(row.original.id)}
            className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10 whitespace-nowrap"
          >
            Review
          </button>
        ),
      enableSorting: false,
    },
  ]

  const monthOptions = [...new Set(rows.map((r) => r.month.slice(0, 7)))]
    .sort()
    .reverse()
    .map((v) => ({ value: v, label: v }))

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        searchAccessor={(r) => `${r.customer_name ?? ""} ${r.customer_id} ${r.message}`}
        searchPlaceholder="Search customer or finding…"
        facetFilters={[
          { columnId: "month", label: "Month", options: monthOptions },
          { columnId: "status", label: "Status", options: [{ value: "Open", label: "Open" }, { value: "Reviewed", label: "Reviewed" }] },
        ]}
        pageSize={25}
        initialSorting={[{ id: "amount", desc: true }]}
        emptyText="No findings — the audit has nothing to say."
      />
      {active && (
        <FindingReviewSheet
          row={active}
          position={{ index: openQueue.findIndex((r) => r.id === active.id), total: openQueue.length }}
          onClose={() => setActiveId(null)}
          onResolved={advance}
        />
      )}
    </>
  )
}
