"use client"

import { useEffect, useState } from "react"
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
import { cn } from "@/lib/utils/cn"

interface VisitDay {
  visit_date: string
  service_names: string | null
  readings: Record<string, number> | null
  chems:
    | { item: string; qty: number; cents: number | null; unit_cents: number | null; category: string | null }[]
    | null
  chem_total_cents: number
}

// consumables.category -> short tag shown next to each chemical line
const CHEM_TAG: Record<string, { label: string; tone: "cyan" | "indigo" | "neutral" | "teal" | "sun" }> = {
  core_chemical: { label: "core", tone: "cyan" },
  specialty_chemical: { label: "specialty", tone: "indigo" },
  replacement_part: { label: "part", tone: "neutral" },
  spa: { label: "spa", tone: "teal" },
  testing: { label: "testing", tone: "sun" },
}
// display order + short labels for the readings block of the calendar
const READING_ORDER: [string, string][] = [
  ["Free Chlorine", "FC"],
  ["pH", "pH"],
  ["Cyanuric Acid", "CYA"],
  ["Total Alkalinity", "TA"],
  ["Salinity", "Salt"],
]

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

export function VisitCalendar({ customerId, month, highlightDates, compare }: { customerId: number; month: string; highlightDates?: string[]; compare?: { selfUsd: number; peerUsd: number } }) {
  const hl = new Set((highlightDates ?? []).map((d) => d.slice(0, 10)))
  const [days, setDays] = useState<VisitDay[] | "loading" | "error">("loading")
  const [collapsed, setCollapsed] = useState(false)

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
  const itemTotals = new Map<
    string,
    { qty: number; cents: number; unit_cents: number | null; category: string | null }
  >()
  for (const d of days) {
    for (const ch of d.chems ?? []) {
      const t =
        itemTotals.get(ch.item) ??
        { qty: 0, cents: 0, unit_cents: ch.unit_cents ?? null, category: ch.category ?? null }
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

  return (
    <div className="rounded-lg border border-line-soft overflow-hidden">
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-white/[0.02]">
            <TableHead className="sticky left-0 bg-bg-elev z-10 w-px">
              <span className="inline-flex items-center gap-1.5">
                Visit date
                <button
                  onClick={() => setCollapsed((c) => !c)}
                  className="h-[18px] px-1.5 rounded border border-line text-[9px] font-mono text-ink-mute hover:text-cyan hover:border-cyan"
                  title={collapsed ? "Show the per-visit columns" : "Collapse to totals"}
                >
                  {collapsed ? "expand" : "collapse"}
                </button>
              </span>
            </TableHead>
            {!collapsed && days.map((d) => {
              const qc = d.service_names?.toUpperCase().includes("QUALITY CONTROL")
              return (
                <TableHead
                  key={d.visit_date}
                  className={cn("text-right px-2", hl.has(d.visit_date.slice(0, 10)) && "bg-coral/15")}
                  title={d.service_names ?? undefined}
                >
                  <span className="text-ink font-mono num">
                    {formatVisitDate(d.visit_date)}
                  </span>
                  {qc && (
                    <span className="ml-1 text-[9px] text-indigo-300 uppercase tracking-wide">
                      QC
                    </span>
                  )}
                </TableHead>
              )
            })}
            <TableHead colSpan={2} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {readingRows.length > 0 && (
            <TableRow className="hover:bg-white/[0.04] bg-white/[0.04]">
              <TableCell
                colSpan={(collapsed ? 0 : days.length) + 3}
                className="sticky left-0 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
              >
                Readings
              </TableCell>
            </TableRow>
          )}
          {readingRows.map(([name, label]) => (
            <TableRow key={name} className="text-ink-dim">
              <TableCell className="sticky left-0 bg-bg-elev z-10">{label}</TableCell>
              {!collapsed && days.map((d) => {
                const v = d.readings?.[name]
                return (
                  <TableCell
                    key={d.visit_date}
                    className={cn(
                      "text-right px-2 font-mono num",
                      v != null && "border-l border-line-soft/30",
                      hl.has(d.visit_date.slice(0, 10)) && "bg-coral/[0.07]",
                    )}
                  >
                    {v ?? ""}
                  </TableCell>
                )
              })}
              {(() => {
                // the reading's TOTAL is its AVERAGE over visits that recorded
                // it — rounded to the step a person reads the water in:
                // pH to .2, CYA/TA/Calcium to 10, FC to whole ppm.
                const vals = days.map((d) => Number(d.readings?.[name])).filter((x) => isFinite(x) && x > 0)
                const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
                const rounded =
                  avg == null
                    ? null
                    : name === "pH"
                      ? (Math.round(avg / 0.2) * 0.2).toFixed(1)
                      : name === "Cyanuric Acid" || name === "Total Alkalinity" || name === "Calcium Hardness"
                        ? (Math.round(avg / 10) * 10).toLocaleString()
                        : name === "Free Chlorine"
                          ? String(Math.round(avg))
                          : avg >= 100
                            ? Math.round(avg).toLocaleString()
                            : avg.toFixed(1)
                return (
                  <TableCell className="text-right pl-4 font-mono num text-ink border-l border-line-soft/30" title={avg != null ? `avg of ${vals.length} recorded` : undefined}>
                    {rounded ?? ""}
                  </TableCell>
                )
              })()}
              <TableCell />
            </TableRow>
          ))}
          {items.length > 0 && (
            <TableRow className="hover:bg-white/[0.04] bg-white/[0.04]">
              <TableCell
                colSpan={(collapsed ? 0 : days.length) + 1}
                className="sticky left-0 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute"
              >
                Chemicals sold
              </TableCell>
              <TableCell className="text-right pl-4 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Qty
              </TableCell>
              <TableCell className="text-right py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Total $
              </TableCell>
            </TableRow>
          )}
          {items.map(([item, tot]) => (
            <TableRow key={item} className="text-ink-dim">
              <TableCell className="sticky left-0 bg-bg-elev z-10" title={item}>
                {item}
                {tot.unit_cents != null && (
                  <span className="ml-1 text-ink-mute">
                    ({formatCurrency(tot.unit_cents / 100)})
                  </span>
                )}
                {tot.category && CHEM_TAG[tot.category] && (
                  <Pill tone={CHEM_TAG[tot.category].tone} className="ml-2 align-middle">
                    {CHEM_TAG[tot.category].label}
                  </Pill>
                )}
              </TableCell>
              {!collapsed && days.map((d) => {
                const qty = qtyByItemDate.get(`${item}|${d.visit_date}`)
                return (
                  <TableCell
                    key={d.visit_date}
                    className={cn(
                      "text-right px-2 font-mono num",
                      qty != null && "border-l border-line-soft/30",
                      hl.has(d.visit_date.slice(0, 10)) && "bg-coral/[0.07]",
                    )}
                  >
                    {qty ?? ""}
                  </TableCell>
                )
              })}
              <TableCell className="text-right pl-4 font-mono num text-ink border-l border-line-soft/30">
                {tot.qty}
              </TableCell>
              <TableCell className="text-right font-mono num text-ink border-l border-line-soft/30">
                {formatCurrency(tot.cents / 100)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        {items.length > 0 && (
          <TableFooter>
            <TableRow className="text-ink hover:bg-transparent">
              <TableCell className="sticky left-0 bg-bg-elev z-10">Chemicals $ / visit</TableCell>
              {!collapsed && days.map((d) => {
                const amt = Number(d.chem_total_cents)
                return (
                  <TableCell
                    key={d.visit_date}
                    className={cn(
                      "text-right px-2 font-mono num",
                      amt > 0 && "border-l border-line-soft/30",
                      hl.has(d.visit_date.slice(0, 10)) && "bg-coral/[0.07]",
                    )}
                  >
                    {amt > 0 ? formatCurrency(amt / 100) : ""}
                  </TableCell>
                )
              })}
              <TableCell />
              <TableCell className="text-right font-mono num font-semibold border-l border-line-soft/30">
                {formatCurrency(grandTotal / 100)}
              </TableCell>
            </TableRow>
          </TableFooter>
        )}
      </Table>
      {compare && (
        <div className="flex justify-end items-baseline gap-4 px-3 py-1.5 font-mono text-[10.5px] text-ink-mute border-t border-line-soft">
          <span>this month <span className="text-ink num">{formatCurrency(grandTotal / 100)}</span></span>
          <span>your typical <span className="text-ink-dim num">{formatCurrency(compare.selfUsd)}</span></span>
          <span>peer seasonal <span className="text-ink-dim num">{formatCurrency(compare.peerUsd)}</span></span>
        </div>
      )}
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
