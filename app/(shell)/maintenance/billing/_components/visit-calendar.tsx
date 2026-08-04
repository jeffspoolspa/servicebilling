"use client"

import React, { useEffect, useState } from "react"
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

export interface ChemItemCompareRow {
  item_name: string
  this_qty: number
  self_avg_qty: number
  peer_avg_qty: number
  this_usd: number
  self_avg_usd: number
  peer_avg_usd: number
}

const fmtQty = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10))

/** This month vs an average: the signed % delta, or 'new' when there's no history. */
function pctOf(thisVal: number, avgVal: number, eps: number): number | "new" | null {
  if (avgVal < eps) return thisVal > eps ? "new" : null
  return Math.round(((thisVal - avgVal) / avgVal) * 100)
}

function AvgCell({ border, children }: { border?: boolean; children?: React.ReactNode }) {
  return (
    <TableCell
      className={cn(
        "text-right px-2 font-mono num text-ink-mute whitespace-nowrap",
        border && "border-l border-line-soft/30",
      )}
    >
      {children}
    </TableCell>
  )
}

function DiffCell({ pct }: { pct: number | "new" | null }) {
  const tone =
    pct === "new" || (typeof pct === "number" && pct >= 100)
      ? "text-coral"
      : typeof pct === "number" && pct >= 25
        ? "text-sun"
        : typeof pct === "number" && pct <= -25
          ? "text-grass"
          : "text-ink-mute"
  return (
    <TableCell className={cn("text-right px-2 font-mono num whitespace-nowrap", tone)}>
      {pct === null ? "" : pct === "new" ? "new" : `${pct >= 0 ? "+" : ""}${pct}%`}
    </TableCell>
  )
}

/** The six comparison cells: self qty | self $ | self Δ, then the same for peers. */
function CompareCells({ thisQty, thisUsd, avgQty, avgUsd, qtyless }: { thisQty: number | null; thisUsd: number; avgQty: number | null; avgUsd: number; qtyless?: boolean }) {
  return (
    <>
      <AvgCell border>{!qtyless && avgQty != null && avgQty >= 0.05 ? fmtQty(avgQty) : ""}</AvgCell>
      <AvgCell>{avgUsd >= 0.005 ? formatCurrency(avgUsd) : ""}</AvgCell>
      <DiffCell
        pct={
          qtyless || thisQty == null
            ? pctOf(thisUsd, avgUsd, 0.5)
            : pctOf(thisQty, avgQty ?? 0, 0.05)
        }
      />
    </>
  )
}

export function VisitCalendar({ customerId, month, highlightDates, compare, itemCompare }: { customerId: number; month: string; highlightDates?: string[]; compare?: { category: string; this_usd: number; self_typical_usd: number; peer_seasonal_usd: number }[]; itemCompare?: ChemItemCompareRow[] }) {
  const hl = new Set((highlightDates ?? []).map((d) => d.slice(0, 10)))
  const [days, setDays] = useState<VisitDay[] | "loading" | "error">("loading")
  const [collapsed, setCollapsed] = useState(false)
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const [showReadings, setShowReadings] = useState(true)
  const [showChems, setShowChems] = useState(true)
  const [showCmp, setShowCmp] = useState(true)

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
  const CAT_ORDER = ["core_chemical", "specialty_chemical", "spa", "testing", "replacement_part", null]
  const items = [...itemTotals.entries()].sort((a, b) => {
    const ca = CAT_ORDER.indexOf(a[1].category as never)
    const cb = CAT_ORDER.indexOf(b[1].category as never)
    if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb)
    return b[1].cents - a[1].cents
  })
  const groupOf = (cat: string | null) => CHEM_TAG[cat ?? ""]?.label ?? "other"
  const cmpByItem = new Map((itemCompare ?? []).map((c) => [c.item_name, c]))
  const cmpOn = cmpByItem.size > 0 && showCmp
  const extraCols = cmpOn ? 6 : 0
  const groupCmp = (g: string) =>
    items
      .filter(([, t2]) => groupOf(t2.category) === g)
      .reduce(
        (s2, [name]) => {
          const c = cmpByItem.get(name)
          return { self: s2.self + Number(c?.self_avg_usd ?? 0), peer: s2.peer + Number(c?.peer_avg_usd ?? 0) }
        },
        { self: 0, peer: 0 },
      )
  const toggleGroup = (g: string) =>
    setHiddenGroups((s) => {
      const n = new Set(s)
      if (n.has(g)) n.delete(g)
      else n.add(g)
      return n
    })
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
            <TableHead colSpan={2 + extraCols} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {readingRows.length > 0 && (
            <TableRow className="hover:bg-white/[0.04] bg-white/[0.04]">
              <TableCell
                colSpan={(collapsed ? 0 : days.length) + 1}
                className="sticky left-0 py-1"
              >
                <button
                  onClick={() => setShowReadings((s) => !s)}
                  className="text-[9px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
                  title={showReadings ? "Collapse the readings" : "Show the readings"}
                >
                  <span className="inline-block w-2.5">{showReadings ? "▾" : "▸"}</span>
                  Readings
                </button>
              </TableCell>
              <TableCell className="text-right pl-4 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Avg
              </TableCell>
              <TableCell colSpan={1 + extraCols} />
            </TableRow>
          )}
          {showReadings && readingRows.map(([name, label]) => (
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
              <TableCell colSpan={1 + extraCols} />
            </TableRow>
          ))}
          {items.length > 0 && (
            <TableRow className="hover:bg-white/[0.04] bg-white/[0.04]">
              <TableCell
                colSpan={(collapsed ? 0 : days.length) + 1}
                className="sticky left-0 py-1"
              >
                <span className="inline-flex items-center gap-1.5">
                  <button
                    onClick={() => setShowChems((s) => !s)}
                    className="text-[9px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
                    title={showChems ? "Collapse the chemicals" : "Show the chemicals"}
                  >
                    <span className="inline-block w-2.5">{showChems ? "▾" : "▸"}</span>
                    Chemicals sold
                  </button>
                  {cmpByItem.size > 0 && (
                    <button
                      onClick={() => setShowCmp((s) => !s)}
                      className="h-[18px] px-1.5 rounded border border-line text-[9px] font-mono text-ink-mute hover:text-cyan hover:border-cyan"
                      title={showCmp ? "Hide the comparison columns" : "Show the comparison columns"}
                    >
                      {showCmp ? "hide compare" : "compare"}
                    </button>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-right pl-4 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Qty
              </TableCell>
              <TableCell className="text-right py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Total $
              </TableCell>
              {cmpOn && (
                <>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    You qty
                  </TableCell>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    You $
                  </TableCell>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    Δ you
                  </TableCell>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    Peer qty
                  </TableCell>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    Peer $
                  </TableCell>
                  <TableCell className="text-right px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    Δ peers
                  </TableCell>
                </>
              )}
            </TableRow>
          )}
          {showChems && items.map(([item, tot], idx) => {
            const g = groupOf(tot.category)
            const prevG = idx > 0 ? groupOf(items[idx - 1][1].category) : null
            const nextG = idx < items.length - 1 ? groupOf(items[idx + 1][1].category) : null
            const groupCents = items.filter(([, t2]) => groupOf(t2.category) === g).reduce((s2, [, t2]) => s2 + t2.cents, 0)
            return (
            <React.Fragment key={item}>
            {g !== prevG && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={(collapsed ? 0 : days.length) + 1}
                  className="sticky left-0 py-0.5 bg-white/[0.015]"
                >
                  <button
                    onClick={() => toggleGroup(g)}
                    className="text-[8.5px] uppercase tracking-[0.12em] text-cyan/80 hover:text-cyan"
                    title={hiddenGroups.has(g) ? "Show the items" : "Collapse to the group total"}
                  >
                    <span className="inline-block w-2.5">{hiddenGroups.has(g) ? "▸" : "▾"}</span>
                    {g}
                  </button>
                </TableCell>
                <TableCell className="py-0.5 bg-white/[0.015]" />
                <TableCell className="text-right py-0.5 font-mono num text-[10px] text-ink-dim bg-white/[0.015]">
                  {formatCurrency(groupCents / 100)}
                </TableCell>
                {cmpOn && (() => {
                  const gc = groupCmp(g)
                  return (
                    <>
                      <CompareCells thisQty={null} thisUsd={groupCents / 100} avgQty={null} avgUsd={gc.self} qtyless />
                      <CompareCells thisQty={null} thisUsd={groupCents / 100} avgQty={null} avgUsd={gc.peer} qtyless />
                    </>
                  )
                })()}
              </TableRow>
            )}
            {!hiddenGroups.has(g) && (
            <TableRow className="text-ink-dim">
              <TableCell className="sticky left-0 bg-bg-elev z-10" title={item}>
                <span className="pl-2">{item}</span>
                {tot.unit_cents != null && (
                  <span className="ml-1 text-ink-mute">
                    ({formatCurrency(tot.unit_cents / 100)})
                  </span>
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
              {cmpOn && (() => {
                const c = cmpByItem.get(item)
                return (
                  <>
                    <CompareCells thisQty={tot.qty} thisUsd={tot.cents / 100} avgQty={Number(c?.self_avg_qty ?? 0)} avgUsd={Number(c?.self_avg_usd ?? 0)} />
                    <CompareCells thisQty={tot.qty} thisUsd={tot.cents / 100} avgQty={Number(c?.peer_avg_qty ?? 0)} avgUsd={Number(c?.peer_avg_usd ?? 0)} />
                  </>
                )
              })()}
            </TableRow>
            )}
            {nextG !== g && null}
            </React.Fragment>
            )
          })}
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
              {cmpOn &&
                (compare?.length ? (
                  <>
                    <CompareCells
                      thisQty={null}
                      thisUsd={grandTotal / 100}
                      avgQty={null}
                      avgUsd={compare.reduce((s2, c) => s2 + Number(c.self_typical_usd), 0)}
                      qtyless
                    />
                    <CompareCells
                      thisQty={null}
                      thisUsd={grandTotal / 100}
                      avgQty={null}
                      avgUsd={compare.reduce((s2, c) => s2 + Number(c.peer_seasonal_usd), 0)}
                      qtyless
                    />
                  </>
                ) : (
                  <TableCell colSpan={6} />
                ))}
            </TableRow>
          </TableFooter>
        )}
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
