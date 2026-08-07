"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronUp, TrendingDown, TrendingUp } from "lucide-react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils/cn"
import { formatCurrency } from "@/lib/utils/format"
import type { MonthOverviewRow } from "../_lib/months"

/**
 * The months page's dashboard, in dashboard-01's anatomy: SectionCards
 * (label, big number, trend badge vs last month, two footer lines) and
 * ONE chart — revenue: the month's value delivered per service day,
 * labor + chemicals stacked as gradient areas, daily or cumulative.
 */

export interface RevenueDayRow {
  service_date: string
  labor_cents: number
  chem_cents: number
}

const LABOR = "#38bdf8" // cyan
const CHEMS = "#fbbf24" // amber — validated pair (CVD ΔE 23+, normal 30)

const TOOLTIP_STYLE = {
  backgroundColor: "#101923",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  fontSize: 11.5,
  color: "#eaf4fb",
} as const

interface Sums {
  billed: number
  collected: number
  outstanding: number
  unsent: number
  accruing: number
  sentInvoices: number
  unsentInvoices: number
  draftMonths: number
}

function sumsOf(rows: MonthOverviewRow[]): Sums {
  const s: Sums = { billed: 0, collected: 0, outstanding: 0, unsent: 0, accruing: 0, sentInvoices: 0, unsentInvoices: 0, draftMonths: 0 }
  for (const m of rows) {
    const inv = m.issued_invoices ?? []
    if (inv.length === 0) {
      s.accruing += m.subtotal_cents / 100
      s.draftMonths++
      continue
    }
    for (const i of inv) {
      const total = Number(i.total_amt ?? 0)
      const bal = Number(i.balance ?? 0)
      s.collected += Math.max(0, total - bal)
      if (i.email_status === "EmailSent") {
        s.outstanding += bal
        s.sentInvoices++
      } else {
        s.unsent += bal
        s.unsentInvoices++
      }
    }
  }
  s.billed = s.collected + s.outstanding + s.unsent + s.accruing
  return s
}

function TrendBadge({ now, prev }: { now: number; prev: number }) {
  if (prev <= 0) return null
  const pct = ((now - prev) / prev) * 100
  const up = pct >= 0
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-px text-[10.5px] font-mono text-ink-dim">
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  )
}

function SectionCard({
  label,
  value,
  now,
  prev,
  footTop,
  footBottom,
}: {
  label: string
  value: string
  now: number
  prev: number
  footTop: string
  footBottom: string
}) {
  return (
    <Card className="bg-gradient-to-t from-cyan/[0.04] to-transparent">
      <CardBody className="py-3.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[11.5px] text-ink-mute">{label}</span>
          <TrendBadge now={now} prev={prev} />
        </div>
        <div className="mt-1 font-display text-[22px] leading-tight text-ink tabular-nums">{value}</div>
        <div className="mt-2 text-[11.5px] text-ink-dim">{footTop}</div>
        <div className="text-[11px] text-ink-mute">{footBottom}</div>
      </CardBody>
    </Card>
  )
}

export function MonthsDashboard({
  rows,
  prevRows,
  revenueByDay,
  monthLabel,
}: {
  rows: MonthOverviewRow[]
  prevRows: MonthOverviewRow[]
  revenueByDay: RevenueDayRow[]
  monthLabel: string
}) {
  const [mode, setMode] = useState<"daily" | "cumulative">("cumulative")
  // Collapsed = just the table in view; the choice sticks across visits.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    setCollapsed(localStorage.getItem("billing-dashboard-collapsed") === "1")
  }, [])
  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem("billing-dashboard-collapsed", next ? "1" : "0")
  }
  const s = useMemo(() => sumsOf(rows), [rows])
  const p = useMemo(() => sumsOf(prevRows), [prevRows])

  const series = useMemo(() => {
    const sorted = [...revenueByDay].sort((a, b) => (a.service_date < b.service_date ? -1 : 1))
    let labAcc = 0
    let chemAcc = 0
    return sorted.map((d) => {
      labAcc += d.labor_cents / 100
      chemAcc += d.chem_cents / 100
      return {
        day: new Date(d.service_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
        labor: mode === "daily" ? d.labor_cents / 100 : labAcc,
        chemicals: mode === "daily" ? d.chem_cents / 100 : chemAcc,
      }
    })
  }, [revenueByDay, mode])

  const laborTotal = revenueByDay.reduce((a, d) => a + d.labor_cents, 0) / 100
  const chemTotal = revenueByDay.reduce((a, d) => a + d.chem_cents, 0) / 100
  const pct = (n: number) => (s.billed > 0 ? `${Math.round((n / s.billed) * 100)}% of billed` : "")

  if (collapsed) {
    // The whole dashboard folds to one summary line; the table gets the room.
    return (
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center gap-x-4 gap-y-1 flex-wrap rounded-xl border border-line bg-white/[0.02] px-4 py-2 text-[12px] hover:bg-white/[0.04]"
      >
        {(
          [
            ["Billed", s.billed],
            ["Collected", s.collected],
            ["Outstanding", s.outstanding],
            ["Not sent", s.unsent + s.accruing],
          ] as const
        ).map(([label, v]) => (
          <span key={label} className="inline-flex items-baseline gap-1.5">
            <span className="text-ink-mute">{label}</span>
            <span className="font-mono text-ink tabular-nums">{formatCurrency(v)}</span>
          </span>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 text-ink-mute">
          dashboard <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end -mb-2">
        <button onClick={toggleCollapsed} className="inline-flex items-center gap-1 text-[11px] text-ink-mute hover:text-ink">
          hide dashboard <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SectionCard
          label="Billed"
          value={formatCurrency(s.billed)}
          now={s.billed}
          prev={p.billed}
          footTop={`${rows.length} customer months`}
          footBottom={`vs ${formatCurrency(p.billed)} last month`}
        />
        <SectionCard
          label="Collected"
          value={formatCurrency(s.collected)}
          now={s.collected}
          prev={p.collected}
          footTop={pct(s.collected)}
          footBottom="payments and credits applied"
        />
        <SectionCard
          label="Outstanding"
          value={formatCurrency(s.outstanding)}
          now={s.outstanding}
          prev={p.outstanding}
          footTop={pct(s.outstanding)}
          footBottom={`${s.sentInvoices} sent invoices awaiting payment`}
        />
        <SectionCard
          label="Not sent yet"
          value={formatCurrency(s.unsent + s.accruing)}
          now={s.unsent + s.accruing}
          prev={p.unsent + p.accruing}
          footTop={pct(s.unsent + s.accruing)}
          footBottom={`${s.unsentInvoices} built + ${s.draftMonths} still accruing`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue — {monthLabel}</CardTitle>
          <span className="text-[11.5px] text-ink-mute ml-2 hidden sm:inline">value delivered per service day</span>
          <div className="ml-auto flex rounded-lg border border-line overflow-hidden">
            {(["daily", "cumulative"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "px-3 h-7 text-[11.5px] capitalize",
                  mode === m ? "bg-cyan/10 text-cyan" : "text-ink-dim hover:text-ink",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody className="pt-2">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 6, right: 12, bottom: 0, left: 12 }}>
                <defs>
                  <linearGradient id="fillLabor" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={LABOR} stopOpacity={0.7} />
                    <stop offset="95%" stopColor={LABOR} stopOpacity={0.08} />
                  </linearGradient>
                  <linearGradient id="fillChems" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHEMS} stopOpacity={0.7} />
                    <stop offset="95%" stopColor={CHEMS} stopOpacity={0.08} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={28}
                  tick={{ fill: "#5b7a90", fontSize: 10.5 }}
                />
                <Tooltip
                  cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v, n) => [formatCurrency(Number(v ?? 0)), String(n)]}
                />
                <Area type="monotone" dataKey="chemicals" stackId="rev" stroke={CHEMS} strokeWidth={2} fill="url(#fillChems)" />
                <Area type="monotone" dataKey="labor" stackId="rev" stroke={LABOR} strokeWidth={2} fill="url(#fillLabor)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            <span className="inline-flex items-center gap-1.5 text-[11.5px]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: LABOR }} />
              <span className="text-ink-dim">Labor</span>
              <span className="font-mono text-ink tabular-nums">{formatCurrency(laborTotal)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11.5px]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHEMS }} />
              <span className="text-ink-dim">Chemicals</span>
              <span className="font-mono text-ink tabular-nums">{formatCurrency(chemTotal)}</span>
            </span>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
