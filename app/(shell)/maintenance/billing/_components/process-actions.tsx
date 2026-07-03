"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"

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
  invoice_list: { qbo_invoice_id: string; doc_number: string | null }[]
  task_count: number
}

interface InvoiceDetailData {
  qbo_invoice_id: string
  doc_number: string | null
  txn_date: string | null
  subtotal: number | null
  total_amt: number | null
  balance: number | null
  email_status: string | null
  line_items:
    | {
        qty: number | null
        amount: number | null
        item_name: string | null
        line_type: string | null
        unit_price: number | null
        description: string | null
      }[]
    | null
}

/**
 * Selectable ready-to-process table + the process action. Processing runs the
 * EXISTING engines (f/billing/monthly_autopay per customer / whole month,
 * f/billing/send_monthly_invoices for the copies) — autopay charges the card
 * and sends the receipt; everyone gets the invoice copy (already paid when
 * autopay ran first).
 */
export function ProcessActions({
  month,
  monthLabel,
  customers,
}: {
  month: string
  monthLabel: string
  customers: ProcessCustomer[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [dryRun, setDryRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  function toggleOpen(id: string) {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

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
    try {
      const resp = await fetch("/api/maintenance-billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month, qbo_customer_ids: ids, dry_run: dryRun }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(json.message ?? "Processing started.")
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
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium text-right">Tasks</th>
              <th className="px-4 py-2 font-medium">Invoices</th>
              <th className="px-4 py-2 font-medium text-right">Amount</th>
              <th className="px-4 py-2 font-medium text-right">Balance</th>
              <th className="px-4 py-2 font-medium">Payment</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <CustomerRow
                key={c.qbo_customer_id}
                c={c}
                checked={selected.has(c.qbo_customer_id)}
                onToggle={() => toggle(c.qbo_customer_id)}
                open={open.has(c.qbo_customer_id)}
                onOpenToggle={() => toggleOpen(c.qbo_customer_id)}
              />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/** One selectable customer row + drill-down: the linked QBO invoice(s) with
 *  line items, fetched lazily on expand. Balance < Amount = credits applied
 *  (balance reads the cache; a just-applied credit lands on the next
 *  webhook/CDC tick). */
function CustomerRow({
  c,
  checked,
  onToggle,
  open,
  onOpenToggle,
}: {
  c: ProcessCustomer
  checked: boolean
  onToggle: () => void
  open: boolean
  onOpenToggle: () => void
}) {
  const credited = c.balance_cents < c.total_cents
  return (
    <>
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
        <td className="px-4 py-2.5 text-ink">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenToggle()
            }}
            className="text-ink-mute mr-1.5 inline-block w-3 hover:text-ink"
            title="Show invoice detail"
          >
            {open ? "▾" : "▸"}
          </button>
          {c.customer_name}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{c.task_count}</td>
        <td className="px-4 py-2.5 font-mono text-xs text-ink-dim">{c.invoices || "—"}</td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink">
          {formatCurrency(c.total_cents / 100)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num">
          <span className={credited ? "text-grass" : "text-ink-dim"}>
            {formatCurrency(c.balance_cents / 100)}
          </span>
          {credited && (
            <div className="text-[10px] text-grass/80">
              −{formatCurrency((c.total_cents - c.balance_cents) / 100)} credited
            </div>
          )}
        </td>
        <td className="px-4 py-2.5">
          {c.on_autopay && c.card ? (
            <span className="inline-flex items-center gap-1.5">
              <Pill tone={c.card.payment_status === "good" ? "teal" : "coral"} dot>
                {c.card.method === "ach"
                  ? "ACH"
                  : `${c.card.card_type ?? "card"} ····${c.card.last_four ?? "?"}`}
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
      {open && (
        <tr className="border-b border-line-soft/40 bg-white/[0.015]">
          <td colSpan={7} className="px-8 py-4">
            <div className="space-y-4">
              {c.invoice_list.length === 0 && (
                <div className="text-[11px] text-ink-mute">No linked invoices.</div>
              )}
              {c.invoice_list.map((inv) => (
                <InvoiceDetail key={inv.qbo_invoice_id} qboInvoiceId={inv.qbo_invoice_id} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function InvoiceDetail({ qboInvoiceId }: { qboInvoiceId: string }) {
  const [inv, setInv] = useState<InvoiceDetailData | "loading" | "error">("loading")

  useEffect(() => {
    let alive = true
    setInv("loading")
    fetch(`/api/maintenance-billing/invoice?qbo_invoice_id=${qboInvoiceId}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setInv(j.invoice as InvoiceDetailData))
      .catch(() => alive && setInv("error"))
    return () => {
      alive = false
    }
  }, [qboInvoiceId])

  if (inv === "loading")
    return <div className="text-[11px] text-ink-mute">Loading invoice…</div>
  if (inv === "error")
    return <div className="text-[11px] text-coral">Failed to load invoice detail.</div>

  const items = (inv.line_items ?? []).filter((li) => li.line_type === "item")
  const memoLine = (inv.line_items ?? []).find(
    (li) => li.line_type === "description" && li.description,
  )
  const tax = (inv.total_amt ?? 0) - (inv.subtotal ?? 0)
  return (
    <div className="rounded-lg border border-line-soft overflow-hidden max-w-2xl">
      <div className="flex items-center justify-between px-4 py-2 bg-white/[0.02] border-b border-line-soft text-[11px]">
        <div className="text-ink">
          Invoice <span className="font-mono">#{inv.doc_number}</span>
          {inv.txn_date && <span className="text-ink-mute ml-2">{inv.txn_date}</span>}
          {memoLine && <span className="text-ink-mute ml-2">· {memoLine.description}</span>}
        </div>
        <div className="flex items-center gap-2">
          {inv.email_status === "EmailSent" && <Pill tone="cyan">sent</Pill>}
          {(inv.balance ?? 0) <= 0 ? (
            <Pill tone="grass">paid</Pill>
          ) : (
            <span className="text-ink-mute">
              balance <span className="font-mono num text-ink">{formatCurrency(inv.balance ?? 0)}</span>
            </span>
          )}
        </div>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft/60">
            <th className="px-4 py-1.5 font-medium">Item</th>
            <th className="px-4 py-1.5 font-medium text-right">Qty</th>
            <th className="px-4 py-1.5 font-medium text-right">Rate</th>
            <th className="px-4 py-1.5 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((li, i) => (
            <tr key={i} className="border-b border-line-soft/30 last:border-0 text-ink-dim">
              <td className="px-4 py-1.5" title={li.description ?? undefined}>
                {(li.item_name ?? li.description ?? "—").replace(/^NA\* - /, "")}
              </td>
              <td className="px-4 py-1.5 text-right font-mono num">{li.qty ?? ""}</td>
              <td className="px-4 py-1.5 text-right font-mono num">
                {li.unit_price != null ? formatCurrency(li.unit_price) : ""}
              </td>
              <td className="px-4 py-1.5 text-right font-mono num text-ink">
                {li.amount != null ? formatCurrency(li.amount) : ""}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-soft text-ink">
            <td className="px-4 py-1.5" colSpan={3}>
              Subtotal{tax > 0.005 && <span className="text-ink-mute"> · tax {formatCurrency(tax)}</span>}
            </td>
            <td className="px-4 py-1.5 text-right font-mono num font-semibold">
              {inv.subtotal != null ? formatCurrency(inv.subtotal) : "—"}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
