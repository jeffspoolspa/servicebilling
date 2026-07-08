"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { Pill } from "@/components/ui/pill"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Ready-to-process as the app DataTable: row selection drives the actions
 * (Hold / Process / Send copies). Processing is fire-and-forget — the route
 * returns a jobId and the Processing chip tracks the DB rows; dry runs poll
 * the job result for the plan. One row per customer (autopay sweeps the
 * customer); doc numbers link to the period detail page.
 */

export interface ProcessCustomer {
  qbo_customer_id: string
  customer_name: string
  total_cents: number
  balance_cents: number
  on_autopay: boolean
  card: {
    method: string | null
    card_type: string | null
    last_four: string | null
    payment_status: string | null
  } | null
  invoice_list: { period_id: string; doc_number: string | null }[]
  task_count: number
  sent: boolean
  segment: string
  office: string
  frequency: string
}

export function ProcessTable({
  customers,
  month,
  monthLabel,
}: {
  customers: ProcessCustomer[]
  month: string
  monthLabel: string
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<ProcessCustomer[]>([])
  const [dryRun, setDryRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  // customers optimistically removed when a live run starts (the server
  // excludes queued periods on the next refresh); bumping runSeq remounts
  // the DataTable so stale index-keyed selection can't survive the removal
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [runSeq, setRunSeq] = useState(0)
  const visible = customers.filter((c) => !hidden.has(c.qbo_customer_id))

  async function process() {
    const ids = selected.map((c) => c.qbo_customer_id)
    if (ids.length === 0) return
    const total = selected.reduce((s, c) => s + c.total_cents, 0)
    if (
      !dryRun &&
      !window.confirm(
        `LIVE processing for ${monthLabel}: ${ids.length} customer(s), ` +
          `${formatCurrency(total / 100)}.\n\nAutopay cards will be charged and ` +
          `invoice emails sent.`,
      )
    )
      return
    setBusy(true)
    setResult(null)
    try {
      const resp = await fetch("/api/maintenance-billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month, qbo_customer_ids: ids, dry_run: dryRun }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      if (!dryRun) {
        // rows leave Ready immediately — the queue pill tracks them from here
        setHidden((prev) => new Set([...prev, ...ids]))
        setSelected([])
        setRunSeq((s) => s + 1)
        setResult(`Processing ${ids.length} customer(s) — follow the queue pill above.`)
        return
      }
      setResult("Dry run queued (waits for the QBO writer lock)…")
      pollDryRun(json.jobId)
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function pollDryRun(jobId: string) {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      try {
        const resp = await fetch(`/api/maintenance-billing/process?job=${jobId}`)
        const json = await resp.json()
        if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
        if (json.completed) {
          const r = json.result ?? {}
          const summary = Object.entries(r.by_status ?? {})
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")
          const plans = (r.results ?? [])
            .map((x: { customer?: string; plan?: string }) =>
              x.plan ? `${x.customer}: ${x.plan}` : null,
            )
            .filter(Boolean)
            .slice(0, 12)
          setResult(
            `Dry run: ${r.periods ?? 0} period(s) — ${summary || "nothing to do"}.` +
              (plans.length ? `\n${plans.join("\n")}` : ""),
          )
          return
        }
      } catch {
        // transient poll failure — keep going
      }
    }
    setResult("Dry run still queued/running — check back or re-run.")
  }

  async function holdSelected() {
    const periodIds = selected.flatMap((c) => c.invoice_list.map((inv) => inv.period_id))
    if (periodIds.length === 0) return
    setBusy(true)
    setResult(null)
    try {
      const resp = await fetch("/api/maintenance-billing/periods/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: periodIds, status: "needs_review" }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(`Held ${json.updated} period(s) for review.`)
      router.refresh()
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function sendCopies() {
    setBusy(true)
    setResult(null)
    try {
      const resp = await fetch("/api/maintenance-billing/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month, dry_run: dryRun }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(`${dryRun ? "Dry-run" : "Live"} invoice send started (job ${json.jobId}).`)
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const columns: ColumnDef<ProcessCustomer>[] = [
    {
      id: "select",
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllRowsSelected()}
          ref={(el) => {
            if (el) el.indeterminate = table.getIsSomeRowsSelected()
          }}
          onChange={(e) => table.toggleAllRowsSelected(e.target.checked)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={(e) => row.toggleSelected(e.target.checked)}
          aria-label="Select row"
        />
      ),
      enableSorting: false,
    },
    {
      id: "customer",
      accessorFn: (r) => r.customer_name,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => <span className="text-ink">{row.original.customer_name}</span>,
    },
    {
      id: "tasks",
      accessorFn: (r) => r.task_count,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tasks" />,
      cell: ({ row }) => (
        <span className="font-mono num text-ink-dim">{row.original.task_count}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "invoices",
      header: () => <span>Invoices</span>,
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.invoice_list.length === 0
            ? "—"
            : row.original.invoice_list.map((inv, i) => (
                <span key={inv.period_id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/maintenance/billing/period/${inv.period_id}?month=${month}` as never}
                    onClick={(e) => e.stopPropagation()}
                    className="text-cyan hover:underline underline-offset-2"
                  >
                    {inv.doc_number ?? "detail"}
                  </Link>
                </span>
              ))}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: "amount",
      accessorFn: (r) => r.total_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
      cell: ({ row }) => (
        <span className="font-mono num">{formatCurrency(row.original.total_cents / 100)}</span>
      ),
      meta: { align: "right" },
    },
    {
      id: "balance",
      accessorFn: (r) => r.balance_cents,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Balance" />,
      cell: ({ row }) => (
        <span className="font-mono num text-sun">
          {formatCurrency(row.original.balance_cents / 100)}
        </span>
      ),
      meta: { align: "right" },
    },
    {
      id: "sent",
      accessorFn: (r) => (r.sent ? 1 : 0),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Sent" />,
      cell: ({ row }) =>
        row.original.sent ? (
          <span className="text-teal">✓</span>
        ) : (
          <span className="text-ink-mute">—</span>
        ),
    },
    {
      id: "payment",
      accessorFn: (r) => (r.on_autopay ? "autopay" : "invoice email"),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Payment" />,
      cell: ({ row }) => {
        const c = row.original
        if (!c.on_autopay)
          return (
            <span className="text-[10px] text-ink-mute border border-line rounded-full px-2 py-0.5">
              invoice email
            </span>
          )
        return (
          <span className="inline-flex items-center gap-1.5">
            <Pill tone="teal" dot>
              {c.card?.method === "ach"
                ? "ACH"
                : `${c.card?.card_type ?? "card"} ····${c.card?.last_four ?? "?"}`}
            </Pill>
            {c.card?.payment_status && c.card.payment_status !== "good" && (
              <span className="text-[10px] text-sun">{c.card.payment_status}</span>
            )}
          </span>
        )
      },
    },
    // facet-only columns
    { id: "segment", accessorFn: (r) => r.segment, header: () => null },
    { id: "office", accessorFn: (r) => r.office, header: () => null },
    { id: "frequency", accessorFn: (r) => r.frequency, header: () => null },
  ]

  return (
    <div className="space-y-3">
      <DataTable
        key={runSeq}
        columns={columns}
        data={visible}
        searchAccessor={(r) =>
          `${r.customer_name} ${r.invoice_list.map((i) => i.doc_number).join(" ")}`
        }
        searchPlaceholder="Search customer or invoice…"
        facetFilters={[
          { columnId: "payment", label: "Payment" },
          { columnId: "segment", label: "Type" },
          { columnId: "office", label: "Office" },
          { columnId: "frequency", label: "Frequency" },
        ]}
        columnVisibility={{ segment: false, office: false, frequency: false }}
        toolbarExtra={
          <>
            <label className="flex items-center gap-1.5 text-[12px] text-ink-mute cursor-pointer">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry run
            </label>
            <button
              onClick={holdSelected}
              disabled={busy || selected.length === 0}
              title="Move selected to Needs Review (held until marked ready)"
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-sun/30 text-sun bg-sun/10 hover:bg-sun/20 disabled:opacity-50"
            >
              Hold selected
            </button>
            <button
              onClick={process}
              disabled={busy || selected.length === 0}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
            >
              {busy ? "Working…" : `Process selected (${selected.length})`}
            </button>
            <button
              onClick={sendCopies}
              disabled={busy}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-cyan/30 text-cyan bg-cyan/10 hover:bg-cyan/20 disabled:opacity-50"
            >
              Send invoice copies
            </button>
          </>
        }
        pageSize={25}
        initialSorting={[{ id: "customer", desc: false }]}
        emptyText="Nothing ready to process."
        onSelectionChange={setSelected}
      />
      {result && (
        <div className="text-[11px] text-ink-mute whitespace-pre-line">
          {selected.length > 0 && (
            <span className="text-ink">
              {selected.length} selected ·{" "}
              {formatCurrency(selected.reduce((s, c) => s + c.total_cents, 0) / 100)} ·{" "}
            </span>
          )}
          {result}
        </div>
      )}
    </div>
  )
}
