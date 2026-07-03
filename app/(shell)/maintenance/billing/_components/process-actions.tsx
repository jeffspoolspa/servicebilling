"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { SortableHeader } from "@/components/ui/sortable-header"
import { formatCurrency } from "@/lib/utils/format"
import { MaintProgressModal, type RunItem } from "./maint-progress-modal"

interface ProcessCustomer {
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
  invoices: string
  invoice_list: { period_id: string; doc_number: string | null }[]
  task_count: number
  sent: boolean
}


/**
 * Selectable ready-to-process table + the process action. Processing runs
 * f/billing/process_maint_period (WAL + idempotency keys): autopay charges the
 * roster's linked card/bank then sends receipt-before-invoice; non-autopay
 * customers get the invoice email. Sorting is URL-driven (SortableHeader),
 * sorted server-side in page.tsx — the work-orders pattern.
 */
export function ProcessActions({
  month,
  monthLabel,
  customers,
  sort,
  dir,
  preserve,
}: {
  month: string
  monthLabel: string
  customers: ProcessCustomer[]
  sort: string
  dir: "asc" | "desc"
  preserve: Record<string, string | undefined>
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dryRun, setDryRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [runItems, setRunItems] = useState<RunItem[]>([])
  const [runFired, setRunFired] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const allIds = customers.map((c) => c.qbo_customer_id)
  const allSelected = selected.size === allIds.length && allIds.length > 0

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function process() {
    const ids = [...selected]
    if (ids.length === 0) return
    const total = customers
      .filter((c) => selected.has(c.qbo_customer_id))
      .reduce((s, c) => s + c.total_cents, 0)
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
    if (!dryRun) {
      // fire-and-forget (WO pattern): the route returns a jobId immediately;
      // the modal tracks progress from the DB rows the engine writes
      setRunItems(
        customers
          .filter((c) => selected.has(c.qbo_customer_id))
          .flatMap((c) =>
            c.invoice_list.map((inv) => ({
              period_id: inv.period_id,
              doc_number: inv.doc_number,
              customer_name: c.customer_name,
            })),
          ),
      )
      setRunFired(false)
      setRunError(null)
      setModalOpen(true)
    }
    try {
      const resp = await fetch("/api/maintenance-billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month, qbo_customer_ids: ids, dry_run: dryRun }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(json.message ?? "Processing started.")
      if (!dryRun) setRunFired(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setResult(`Failed: ${msg}`)
      if (!dryRun) setRunError(msg)
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
      setResult(
        `${dryRun ? "Dry-run" : "Live"} invoice send started (job ${json.jobId}).`,
      )
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (customers.length === 0) return null

  return (
    <div className="space-y-3">
      <MaintProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        items={runItems}
        runError={runError}
        fired={runFired}
      />
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-[12px] text-ink-mute">
          {selected.size} of {customers.length} selected ·{" "}
          {formatCurrency(
            customers
              .filter((c) => selected.has(c.qbo_customer_id))
              .reduce((s, c) => s + c.total_cents, 0) / 100,
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-ink-mute cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            Dry run
          </label>
          <button
            onClick={process}
            disabled={busy || selected.size === 0}
            className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
          >
            {busy ? "Working…" : `Process selected (${selected.size})`}
          </button>
          <button
            onClick={sendCopies}
            disabled={busy}
            className="px-3 py-1.5 text-[12px] font-medium rounded border border-cyan/30 text-cyan bg-cyan/10 hover:bg-cyan/20 disabled:opacity-50"
          >
            Send invoice copies
          </button>
        </div>
      </div>
      {result && <div className="text-[11px] text-ink-mute">{result}</div>}

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(allIds))
                  }
                />
              </th>
              {(
                [
                  { key: "name", label: "Customer", align: "left", defaultDir: "asc" },
                  { key: "tasks", label: "Tasks", align: "right", defaultDir: "desc" },
                  { key: null, label: "Invoices", align: "left", defaultDir: "desc" },
                  { key: "amount", label: "Amount", align: "right", defaultDir: "desc" },
                  { key: "balance", label: "Balance", align: "right", defaultDir: "desc" },
                  { key: "sent", label: "Sent", align: "left", defaultDir: "asc" },
                  { key: "payment", label: "Payment", align: "left", defaultDir: "asc" },
                ] as const
              ).map((col) => (
                <th
                  key={col.label}
                  className={`px-4 py-2 font-medium${col.align === "right" ? " text-right" : ""}`}
                >
                  {col.key ? (
                    <SortableHeader
                      label={col.label}
                      column={col.key}
                      currentSort={sort}
                      currentDir={dir}
                      basePath="/maintenance/billing/process"
                      preserve={preserve}
                      defaultDir={col.defaultDir}
                      align={col.align}
                    />
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <CustomerRow
                key={c.qbo_customer_id}
                c={c}
                month={month}
                checked={selected.has(c.qbo_customer_id)}
                onToggle={() => toggle(c.qbo_customer_id)}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/** One selectable customer row. Doc numbers link to the billing-period
 *  detail page (invoice + visit calendar + processing attempts); the back
 *  button there returns to this exact filtered view. */
function CustomerRow({
  c,
  month,
  checked,
  onToggle,
}: {
  c: ProcessCustomer
  month: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <tr
      className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02] cursor-pointer"
      onClick={onToggle}
    >
      <td className="px-4 py-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      <td className="px-4 py-2.5 text-ink">{c.customer_name}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{c.task_count}</td>
      <td className="px-4 py-2.5 font-mono text-xs">
        {c.invoice_list.length === 0
          ? "—"
          : c.invoice_list.map((inv, i) => (
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
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink">
        {formatCurrency(c.total_cents / 100)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-sun">
        {formatCurrency(c.balance_cents / 100)}
      </td>
      <td className="px-4 py-2.5">
        {c.sent ? <span className="text-teal">✓</span> : <span className="text-ink-mute">—</span>}
      </td>
      <td className="px-4 py-2.5">
        {c.on_autopay && c.card ? (
          <span className="inline-flex items-center gap-1.5">
            <Pill tone={c.card.payment_status === "good" ? "teal" : "coral"} dot>
              {c.card.method === "ach"
                ? "ACH"
                : `${c.card.card_type ?? "card"} \u00b7\u00b7\u00b7\u00b7${c.card.last_four ?? "?"}`}
            </Pill>
            {c.card.payment_status !== "good" && (
              <span className="text-[10px] text-coral">{c.card.payment_status}</span>
            )}
          </span>
        ) : (
          <Pill tone="neutral">invoice email</Pill>
        )}
      </td>
    </tr>
  )
}
