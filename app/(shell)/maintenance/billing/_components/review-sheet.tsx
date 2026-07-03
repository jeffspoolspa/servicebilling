"use client"

import { useState } from "react"
import Link from "next/link"
import { Pill } from "@/components/ui/pill"
import { Sheet } from "@/components/ui/sheet"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"
import { REASON_LABEL } from "../_lib/status"
import { PeriodTabs } from "./period-tabs"
import { ReviewQueueActions, RetryPreprocess } from "./review-queue-actions"

/**
 * The Needs Review drill-down as a slide-in sheet: the summarized period
 * detail without leaving the queue. Header stats (Expected / ION / QBO /
 * Balance), the reconcile diff parsed into a recorded-vs-billed table, the
 * chem-flag context, then the full invoice + visit tabs (PeriodTabs
 * self-fetches), with the release actions in reach.
 */

export interface ReviewSheetRow {
  name: string
  month: string // 'YYYY-MM'
  customer_id: number | null
  qbo_customer_id: string | null
  ids: string[]
  reasons: string[]
  notes: string[]
  opError: boolean
  chemFlagged: boolean
  chem: { total_usd: number; median_usd: number; x_median: number; peer_group: string } | null
  expected: number // cents
  ion: number | null // cents
  qbo_total: number // cents
  qbo_balance: number // cents
  tasks: {
    period_id: string
    qbo_invoice_id: string | null
    doc_number: string | null
    service_name: string | null
  }[]
}

interface DiffLine {
  item: string
  recorded: string
  billed: string
}

/** notes look like: "multi_invoice:2; labor_diff:+0; cons_underbilled:ITEM A:1.0>0.0,ITEM B:3.0>2.5" */
function parseNotes(notes: string[]): { labor: string | null; diffs: DiffLine[]; other: string[] } {
  let labor: string | null = null
  const diffs: DiffLine[] = []
  const other: string[] = []
  for (const note of notes) {
    for (const bit of note.split(";").map((s) => s.trim())) {
      if (bit.startsWith("labor_diff:")) {
        const v = bit.slice("labor_diff:".length)
        if (v !== "+0") labor = v
      } else if (bit.startsWith("cons_underbilled:")) {
        for (const entry of bit.slice("cons_underbilled:".length).split(",")) {
          const m = entry.match(/^(.*):([\d.]+)>([\d.]+)$/)
          if (m) diffs.push({ item: m[1], recorded: m[2], billed: m[3] })
        }
      } else if (bit) {
        other.push(bit)
      }
    }
  }
  return { labor, diffs, other }
}

export function ReviewSheet({ row }: { row: ReviewSheetRow }) {
  const [open, setOpen] = useState(false)
  const invoiced = row.tasks.filter((t) => t.qbo_invoice_id)
  const [invoiceIdx, setInvoiceIdx] = useState(0)
  const current = invoiced[Math.min(invoiceIdx, Math.max(invoiced.length - 1, 0))]
  const { labor, diffs, other } = parseNotes(row.notes)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10"
      >
        Review
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={row.name}
        description={
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            {row.reasons.map((r) => (
              <Pill key={r} tone="coral">
                {REASON_LABEL[r] ?? r}
              </Pill>
            ))}
          </span>
        }
      >
        <div className="space-y-5">
          {/* amounts */}
          <div className="grid grid-cols-4 gap-3">
            <SheetStat label="Expected" value={formatCurrency(row.expected / 100)} />
            <SheetStat label="ION" value={row.ion != null ? formatCurrency(row.ion / 100) : "—"} />
            <SheetStat label="QBO" value={formatCurrency(row.qbo_total / 100)} />
            <SheetStat
              label="Balance"
              value={formatCurrency(row.qbo_balance / 100)}
              tone={row.qbo_balance > 0 ? "sun" : "grass"}
            />
          </div>

          {/* reconcile diff: what we recorded vs what the invoice bills */}
          {(diffs.length > 0 || labor || other.length > 0) && (
            <div className="border border-line rounded-lg overflow-hidden">
              <div className="px-3.5 py-2 text-[11px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft bg-white/[0.02]">
                Recorded vs billed
              </div>
              {labor && (
                <div className="px-3.5 py-2 text-[12px] text-sun border-b border-line-soft/50">
                  labor off by {labor}
                </div>
              )}
              {diffs.length > 0 && (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-ink-mute border-b border-line-soft/50">
                      <th className="px-3.5 py-1.5 font-medium">Item</th>
                      <th className="px-3.5 py-1.5 font-medium text-right">Recorded</th>
                      <th className="px-3.5 py-1.5 font-medium text-right">Billed</th>
                      <th className="px-3.5 py-1.5 font-medium text-right">Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d) => (
                      <tr key={d.item} className="border-b border-line-soft/30 last:border-0">
                        <td className="px-3.5 py-1.5 text-ink">{d.item}</td>
                        <td className="px-3.5 py-1.5 text-right font-mono num">{d.recorded}</td>
                        <td className="px-3.5 py-1.5 text-right font-mono num">{d.billed}</td>
                        <td className="px-3.5 py-1.5 text-right font-mono num text-sun">
                          {(Number(d.recorded) - Number(d.billed)).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {other.length > 0 && (
                <div className="px-3.5 py-1.5 text-[10px] text-ink-mute font-mono">
                  {other.join(" · ")}
                </div>
              )}
            </div>
          )}

          {/* chem flag context */}
          {row.chem && (
            <div className="border border-coral/25 bg-coral/[0.04] rounded-lg px-3.5 py-2.5 text-[12px]">
              <span className="text-coral font-medium">Chem flag:</span>{" "}
              {formatCurrency(row.chem.total_usd)} vs{" "}
              {formatCurrency(row.chem.median_usd)} {row.chem.peer_group.replace(/_/g, " ")}{" "}
              median ({row.chem.x_median}x)
              {row.customer_id != null && (
                <Link
                  href={`/maintenance/billing/review/${row.customer_id}?month=${row.month}` as never}
                  className="ml-2 text-coral underline underline-offset-2"
                >
                  full chem breakdown →
                </Link>
              )}
            </div>
          )}

          {/* invoice picker for multi-task customers */}
          {invoiced.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {invoiced.map((t, i) => (
                <button
                  key={t.period_id}
                  onClick={() => setInvoiceIdx(i)}
                  className={cn(
                    "px-2.5 py-1 rounded-full border text-[11px] font-mono",
                    i === invoiceIdx
                      ? "border-cyan/50 text-cyan bg-cyan/10"
                      : "border-line text-ink-mute hover:text-ink",
                  )}
                >
                  #{t.doc_number ?? "?"}
                </button>
              ))}
            </div>
          )}

          {/* invoice + billing-month tabs (self-fetching) */}
          {current ? (
            <PeriodTabs
              key={current.period_id}
              qboInvoiceId={current.qbo_invoice_id}
              customerId={row.customer_id}
              month={row.month}
              attempts={[]}
              creditsApplied={null}
            />
          ) : (
            <div className="text-[12px] text-ink-mute">No linked invoice.</div>
          )}

          {/* actions */}
          <div className="flex items-center gap-2 pt-1 border-t border-line-soft pt-3">
            {row.opError && row.qbo_customer_id && (
              <RetryPreprocess qboCustomerId={row.qbo_customer_id} month={row.month} />
            )}
            {!row.chemFlagged && <ReviewQueueActions ids={row.ids} />}
            {current && (
              <Link
                href={`/maintenance/billing/period/${current.period_id}?month=${row.month}` as never}
                className="ml-auto text-[11px] text-ink-mute hover:text-cyan"
              >
                full detail page →
              </Link>
            )}
          </div>
        </div>
      </Sheet>
    </>
  )
}

function SheetStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "sun" | "grass"
}) {
  return (
    <div className="border border-line rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div
        className={cn(
          "text-[14px] font-mono num mt-0.5",
          tone === "sun" ? "text-sun" : tone === "grass" ? "text-grass" : "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  )
}
