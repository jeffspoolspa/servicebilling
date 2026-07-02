"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/utils/format"
import { STATUS_LABEL, STATUS_TONE } from "../_lib/status"
import type { ProcessingStatus } from "../_lib/queries"

export interface TaskLine {
  id: string
  service_name: string | null
  category: string | null
  frequency: string | null
  visits: number
  labor_cents: number | null
  chem_cents: number | null
  expected_cents: number | null
  unpriced: number
  ion_cents: number | null
  ion_numbers: string | null
  ion_match: "match" | "mismatch" | "missing"
  reconcile_status: string
  status: ProcessingStatus
}

export interface CustomerBill {
  key: string
  customer_id: number | null
  name: string
  on_autopay: boolean
  hold: boolean
  visits: number
  labor_cents: number
  chem_cents: number
  expected_cents: number
  ion_cents: number | null
  ion_chips: { number: string; match: "match" | "mismatch" | "missing" }[]
  qbo_docs: string
  statuses: ProcessingStatus[]
  tasks: TaskLine[]
}

interface VisitDay {
  visit_date: string
  service_names: string | null
  readings: Record<string, number> | null
  chems: { item: string; qty: number; cents: number | null }[] | null
  chem_total_cents: number
}

const ION_TONE = { match: "grass", mismatch: "coral", missing: "neutral" } as const
// display order + short labels for the readings block of the calendar
const READING_ORDER: [string, string][] = [
  ["Free Chlorine", "FC"],
  ["pH", "pH"],
  ["Cyanuric Acid", "CYA"],
  ["Total Alkalinity", "TA"],
  ["Total Chlorine", "TC"],
  ["Salinity", "Salt"],
]

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

/**
 * The Bills table: one collapsible row per customer. Click a row to reveal the
 * task list (a QC task shows here — and as a second ION invoice chip on the
 * row) and the visit calendar: dates as columns, readings grouped above the
 * chemicals sold per visit, with totals.
 */
export function BillsTable({ customers, month }: { customers: CustomerBill[]; month: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    const next = new Set(open)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpen(next)
  }

  return (
    <Card>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft">
            <th className="px-4 py-2 font-medium">Customer</th>
            <th className="px-4 py-2 font-medium text-right">Visits</th>
            <th className="px-4 py-2 font-medium text-right">Labor</th>
            <th className="px-4 py-2 font-medium text-right">Chems</th>
            <th className="px-4 py-2 font-medium text-right">Expected</th>
            <th className="px-4 py-2 font-medium text-right">ION invoice</th>
            <th className="px-4 py-2 font-medium">QBO</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-ink-mute">
                No bills match this filter.
              </td>
            </tr>
          )}
          {customers.map((c) => (
            <CustomerRows
              key={c.key}
              c={c}
              month={month}
              open={open.has(c.key)}
              onToggle={() => toggle(c.key)}
            />
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function CustomerRows({
  c,
  month,
  open,
  onToggle,
}: {
  c: CustomerBill
  month: string
  open: boolean
  onToggle: () => void
}) {
  const statuses = [...new Set(c.statuses)]
  return (
    <>
      <tr
        className="border-b border-line-soft/40 hover:bg-white/[0.02] cursor-pointer align-top"
        onClick={onToggle}
      >
        <td className="px-4 py-2.5 text-ink">
          <span className="text-ink-mute mr-1.5 inline-block w-3">{open ? "▾" : "▸"}</span>
          {c.name}
          {c.on_autopay && (
            <span className="ml-2 text-[10px] text-teal uppercase tracking-wide">autopay</span>
          )}
          {c.hold && (
            <Pill tone="coral" dot className="ml-2">
              hold
            </Pill>
          )}
          {c.tasks.length > 1 && (
            <span className="ml-2 text-[10px] text-ink-mute">{c.tasks.length} tasks</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{c.visits}</td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
          {cents(c.labor_cents)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
          {cents(c.chem_cents)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono num text-ink">
          {cents(c.expected_cents)}
        </td>
        <td className="px-4 py-2.5 text-right">
          <span className="font-mono num text-ink-dim">{cents(c.ion_cents)}</span>
          <div className="mt-0.5 flex flex-wrap gap-1 justify-end">
            {c.ion_chips.map((chip) => (
              <Pill key={chip.number} tone={ION_TONE[chip.match]}>
                #{chip.number}
              </Pill>
            ))}
          </div>
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-ink-dim">{c.qbo_docs || "—"}</td>
        <td className="px-4 py-2.5">
          <div className="flex flex-col items-start gap-1">
            {statuses.map((s) => (
              <Pill key={s} tone={STATUS_TONE[s]} dot>
                {STATUS_LABEL[s]}
              </Pill>
            ))}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line-soft/40 bg-white/[0.015]">
          <td colSpan={8} className="px-6 py-4">
            <BillDetail c={c} month={month} />
          </td>
        </tr>
      )}
    </>
  )
}

function BillDetail({ c, month }: { c: CustomerBill; month: string }) {
  return (
    <div className="space-y-4">
      <table className="w-auto min-w-[60%] text-[11px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft">
            <th className="pr-6 py-1.5 font-medium">Task</th>
            <th className="pr-6 py-1.5 font-medium text-right">Visits</th>
            <th className="pr-6 py-1.5 font-medium text-right">Labor</th>
            <th className="pr-6 py-1.5 font-medium text-right">Chems</th>
            <th className="pr-6 py-1.5 font-medium text-right">Expected</th>
            <th className="pr-6 py-1.5 font-medium text-right">ION invoice</th>
            <th className="py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {c.tasks.map((t) => (
            <tr key={t.id} className="border-b border-line-soft/30 last:border-0">
              <td className="pr-6 py-1.5 text-ink-dim">
                {t.service_name ?? "—"}
                <span className="ml-2 text-[10px] text-ink-mute">
                  {[t.category, t.frequency].filter(Boolean).join(" · ")}
                </span>
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">{t.visits}</td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">
                {cents(t.labor_cents)}
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink-dim">
                {cents(t.chem_cents)}
                {t.unpriced > 0 && (
                  <span className="ml-1 text-[10px] text-sun font-sans">
                    {t.unpriced} unpriced
                  </span>
                )}
              </td>
              <td className="pr-6 py-1.5 text-right font-mono num text-ink">
                {cents(t.expected_cents)}
              </td>
              <td className="pr-6 py-1.5 text-right">
                <span className="font-mono num text-ink-dim">{cents(t.ion_cents)}</span>
                <span className="ml-1.5">
                  <Pill tone={ION_TONE[t.ion_match]}>
                    {t.ion_numbers ? `#${t.ion_numbers}` : t.ion_match}
                  </Pill>
                </span>
              </td>
              <td className="py-1.5">
                <Pill tone={STATUS_TONE[t.status]} dot>
                  {STATUS_LABEL[t.status]}
                </Pill>
                {t.reconcile_status === "mismatch" && (
                  <Pill tone="coral" className="ml-1">
                    reconcile mismatch
                  </Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {c.customer_id != null ? (
        <VisitCalendar customerId={c.customer_id} month={month} />
      ) : (
        <div className="text-[11px] text-ink-mute">
          No customer link — visit calendar unavailable.
        </div>
      )}
    </div>
  )
}

function VisitCalendar({ customerId, month }: { customerId: number; month: string }) {
  const [days, setDays] = useState<VisitDay[] | "loading" | "error">("loading")

  useEffect(() => {
    let alive = true
    setDays("loading")
    fetch(`/api/maintenance-billing/visits?customer_id=${customerId}&month=${month}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setDays(j.days as VisitDay[]))
      .catch(() => alive && setDays("error"))
    return () => {
      alive = false
    }
  }, [customerId, month])

  if (days === "loading") {
    return <div className="text-[11px] text-ink-mute">Loading visits…</div>
  }
  if (days === "error") {
    return <div className="text-[11px] text-coral">Failed to load visit detail.</div>
  }
  if (days.length === 0) {
    return <div className="text-[11px] text-ink-mute">No visits recorded this month.</div>
  }

  const readingRows = READING_ORDER.filter(([name]) =>
    days.some((d) => d.readings?.[name] != null),
  )
  const itemTotals = new Map<string, { qty: number; cents: number }>()
  for (const d of days) {
    for (const ch of d.chems ?? []) {
      const t = itemTotals.get(ch.item) ?? { qty: 0, cents: 0 }
      t.qty += Number(ch.qty)
      t.cents += ch.cents ?? 0
      itemTotals.set(ch.item, t)
    }
  }
  const items = [...itemTotals.entries()].sort((a, b) => b[1].cents - a[1].cents)
  const qtyByItemDate = new Map<string, number>()
  for (const d of days) {
    for (const ch of d.chems ?? []) {
      qtyByItemDate.set(`${ch.item}|${d.visit_date}`, Number(ch.qty))
    }
  }
  const grandTotal = days.reduce((s, d) => s + Number(d.chem_total_cents), 0)
  const totalQty = [...itemTotals.values()].reduce((s, t) => s + t.qty, 0)

  return (
    <div className="rounded-lg border border-line-soft overflow-hidden">
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-white/[0.02]">
            <TableHead className="sticky left-0 bg-bg-elev z-10 min-w-[180px]">
              Visit date
            </TableHead>
            {days.map((d) => {
              const qc = d.service_names?.toUpperCase().includes("QUALITY CONTROL")
              return (
                <TableHead
                  key={d.visit_date}
                  className="text-right px-2"
                  title={d.service_names ?? undefined}
                >
                  <div className="text-ink font-mono num">
                    {formatVisitDate(d.visit_date)}
                  </div>
                  {qc && (
                    <div className="text-[9px] text-indigo-300 uppercase tracking-wide leading-3">
                      QC
                    </div>
                  )}
                </TableHead>
              )
            })}
            <TableHead className="text-right pl-4">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readingRows.length > 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={days.length + 2}
                className="sticky left-0 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
              >
                Readings
              </TableCell>
            </TableRow>
          )}
          {readingRows.map(([name, label]) => (
            <TableRow key={name} className="text-ink-dim">
              <TableCell className="sticky left-0 bg-bg-elev z-10">{label}</TableCell>
              {days.map((d) => (
                <TableCell key={d.visit_date} className="text-right px-2 font-mono num">
                  {d.readings?.[name] ?? ""}
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
          ))}
          {items.length > 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={days.length + 2}
                className="sticky left-0 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
              >
                Chemicals sold
              </TableCell>
            </TableRow>
          )}
          {items.map(([item, tot]) => (
            <TableRow key={item} className="text-ink-dim">
              <TableCell
                className="sticky left-0 bg-bg-elev z-10 max-w-[220px] truncate"
                title={item}
              >
                {item}
              </TableCell>
              {days.map((d) => (
                <TableCell key={d.visit_date} className="text-right px-2 font-mono num">
                  {qtyByItemDate.get(`${item}|${d.visit_date}`) ?? ""}
                </TableCell>
              ))}
              <TableCell className="text-right pl-4 font-mono num text-ink">
                {tot.qty} · {formatCurrency(tot.cents / 100)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="text-ink hover:bg-transparent">
            <TableCell className="sticky left-0 bg-bg-elev z-10">Chemicals $ / visit</TableCell>
            {days.map((d) => (
              <TableCell key={d.visit_date} className="text-right px-2 font-mono num">
                {Number(d.chem_total_cents) > 0
                  ? formatCurrency(Number(d.chem_total_cents) / 100)
                  : ""}
              </TableCell>
            ))}
            <TableCell className="text-right pl-4 font-mono num font-semibold">
              {totalQty > 0 && `${totalQty} · `}
              {formatCurrency(grandTotal / 100)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  )
}

/** '2026-06-02' -> 'Jun 2' */
function formatVisitDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z")
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d)
}
