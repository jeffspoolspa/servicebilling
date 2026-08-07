"use client"

import { useMemo } from "react"
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { displayStatus, MONTH_DISPLAY_STATUSES, type MonthDisplayStatus, type MonthOverviewRow } from "../_lib/months"

/**
 * The month's DASHBOARD (dashboard-01 shape): stat cards up top — billed,
 * collected, outstanding, unsent — then the revenue split and the customer
 * breakdown as charts. Colors match the table's status pills exactly, so
 * a segment and a pill are the same fact in two places.
 */

const HEX: Record<string, string> = {
  collected: "#34d399", // grass — money in
  outstanding: "#fbbf24", // sun — sent, awaiting payment
  unsent: "#38bdf8", // cyan — built, not sent
  accruing: "#5b7a90", // ink-mute — still accruing (draft)
}
const STATUS_HEX: Record<MonthDisplayStatus, string> = {
  "in-progress": "#5b7a90",
  held: "#fbbf24",
  unreconciled: "#fb7185",
  issued: "#38bdf8",
  open: "#2dd4bf",
  closed: "#34d399",
}

const TOOLTIP_STYLE = {
  backgroundColor: "#101923",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  fontSize: 11.5,
  color: "#eaf4fb",
} as const

function StatCard({ label, value, badge, foot }: { label: string; value: string; badge?: string; foot: string }) {
  return (
    <Card>
      <CardBody className="py-3.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[11.5px] text-ink-mute">{label}</span>
          {badge && (
            <span className="rounded-full border border-line px-2 py-px text-[10.5px] font-mono text-ink-dim">{badge}</span>
          )}
        </div>
        <div className="mt-1 font-display text-[22px] leading-tight text-ink tabular-nums">{value}</div>
        <div className="mt-0.5 text-[11px] text-ink-mute">{foot}</div>
      </CardBody>
    </Card>
  )
}

export function MonthsDashboard({ rows, monthLabel }: { rows: MonthOverviewRow[]; monthLabel: string }) {
  const s = useMemo(() => {
    let collected = 0, outstanding = 0, unsent = 0, accruing = 0
    let sentInvoices = 0, unsentInvoices = 0, draftMonths = 0
    const statusCounts = new Map<MonthDisplayStatus, number>()
    const owing: { name: string; balance: number }[] = []
    for (const m of rows) {
      const d = displayStatus(m)
      statusCounts.set(d, (statusCounts.get(d) ?? 0) + 1)
      const inv = m.issued_invoices ?? []
      if (inv.length === 0) {
        accruing += m.subtotal_cents / 100
        draftMonths++
        continue
      }
      let monthOwing = 0
      for (const i of inv) {
        const total = Number(i.total_amt ?? 0)
        const bal = Number(i.balance ?? 0)
        collected += Math.max(0, total - bal)
        if (i.email_status === "EmailSent") {
          outstanding += bal
          sentInvoices++
          monthOwing += bal
        } else {
          unsent += bal
          unsentInvoices++
        }
      }
      if (monthOwing > 0) owing.push({ name: m.customer_name ?? String(m.customer_id), balance: monthOwing })
    }
    const billed = collected + outstanding + unsent + accruing
    owing.sort((a, b) => b.balance - a.balance)
    return { collected, outstanding, unsent, accruing, billed, sentInvoices, unsentInvoices, draftMonths, statusCounts, owing }
  }, [rows])

  const pct = (n: number) => (s.billed > 0 ? `${Math.round((n / s.billed) * 100)}%` : "—")
  const revenueRow = [{ name: monthLabel, collected: s.collected, outstanding: s.outstanding, unsent: s.unsent, accruing: s.accruing }]
  const statusData = MONTH_DISPLAY_STATUSES.map((k) => ({ status: k, customers: s.statusCounts.get(k) ?? 0 }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Billed" value={formatCurrency(s.billed)} foot={`${rows.length} customer months`} />
        <StatCard label="Collected" value={formatCurrency(s.collected)} badge={pct(s.collected)} foot="payments and credits applied" />
        <StatCard label="Outstanding" value={formatCurrency(s.outstanding)} badge={pct(s.outstanding)} foot={`${s.sentInvoices} sent invoices awaiting payment`} />
        <StatCard
          label="Not sent yet"
          value={formatCurrency(s.unsent + s.accruing)}
          badge={pct(s.unsent + s.accruing)}
          foot={`${s.unsentInvoices} built + ${s.draftMonths} still accruing`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Revenue — {monthLabel}</CardTitle>
          </CardHeader>
          <CardBody className="pt-1">
            <div className="h-[64px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueRow} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 8 }} barSize={26}>
                  <XAxis type="number" hide domain={[0, "dataMax"]} />
                  <YAxis type="category" dataKey="name" hide />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.03)" }}
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v, n) => [formatCurrency(Number(v ?? 0)), String(n)]}
                  />
                  {(["collected", "outstanding", "unsent", "accruing"] as const).map((k, i, all) => (
                    <Bar
                      key={k}
                      dataKey={k}
                      stackId="rev"
                      fill={HEX[k]}
                      stroke="#0b1117"
                      strokeWidth={1}
                      radius={i === 0 ? [4, 0, 0, 4] : i === all.length - 1 ? [0, 4, 4, 0] : 0}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
              {(
                [
                  ["collected", "Collected"],
                  ["outstanding", "Outstanding"],
                  ["unsent", "Built, not sent"],
                  ["accruing", "Still accruing"],
                ] as const
              ).map(([k, label]) => (
                <span key={k} className="inline-flex items-center gap-1.5 text-[11.5px]">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: HEX[k] }} />
                  <span className="text-ink-dim">{label}</span>
                  <span className="font-mono text-ink tabular-nums">{formatCurrency(s[k])}</span>
                  <span className="text-ink-mute">{pct(s[k])}</span>
                </span>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top open balances</CardTitle>
          </CardHeader>
          <CardBody className="pt-1 space-y-1.5">
            {s.owing.length === 0 ? (
              <span className="text-[12px] text-ink-mute">Nothing outstanding.</span>
            ) : (
              s.owing.slice(0, 6).map((o) => (
                <div key={o.name} className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-ink truncate">{o.name}</span>
                  <span className="font-mono text-[12px] text-sun tabular-nums">{formatCurrency(o.balance)}</span>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Customers by status</CardTitle>
        </CardHeader>
        <CardBody className="pt-1">
          <div className="h-[170px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusData} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 8 }} barSize={14}>
                <XAxis type="number" hide domain={[0, "dataMax"]} />
                <YAxis
                  type="category"
                  dataKey="status"
                  width={96}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#9cb6c9", fontSize: 11.5 }}
                />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.03)" }} contentStyle={TOOLTIP_STYLE} formatter={(v) => [Number(v ?? 0), "customers"]} />
                <Bar dataKey="customers" radius={[0, 4, 4, 0]}>
                  {statusData.map((d) => (
                    <Cell key={d.status} fill={STATUS_HEX[d.status as MonthDisplayStatus]} />
                  ))}
                  <LabelList dataKey="customers" position="right" style={{ fill: "#9cb6c9", fontSize: 11 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
