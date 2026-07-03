"use client"

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"
import { InvoiceDetail } from "./invoice-detail"
import { VisitCalendar } from "./visit-calendar"
import type { AttemptRow, BillingPeriodRow } from "../_lib/queries"

type CreditsApplied = BillingPeriodRow["credits_applied"]

/**
 * The billing-period detail tabs: the linked QBO invoice (line items), the
 * billing month (visit calendar — what was actually done/sold), and the
 * processing attempts (the customer-month's autopay transactions).
 */
export function PeriodTabs({
  qboInvoiceId,
  customerId,
  month,
  attempts,
  creditsApplied,
}: {
  qboInvoiceId: string | null
  customerId: number | null
  month: string
  attempts: AttemptRow[]
  creditsApplied: CreditsApplied
}) {
  const [tab, setTab] = useState<"invoice" | "visits" | "processing">("invoice")

  const TABS = [
    { key: "invoice" as const, label: "Invoice" },
    { key: "visits" as const, label: "Billing month" },
    { key: "processing" as const, label: `Processing (${attempts.length})` },
  ]

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-line-soft">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3.5 py-2 text-[12.5px] -mb-px border-b-2",
              tab === t.key
                ? "text-ink border-cyan font-medium"
                : "text-ink-mute border-transparent hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "invoice" && (
        <div className="space-y-4">
          {qboInvoiceId ? (
            <InvoiceDetail qboInvoiceId={qboInvoiceId} />
          ) : (
            <div className="text-[12px] text-ink-mute">
              No QBO invoice linked yet — it appears here when the ION sync lands in the cache.
            </div>
          )}
          <CreditsTable credits={creditsApplied} />
        </div>
      )}

      {tab === "visits" &&
        (customerId != null ? (
          <VisitCalendar customerId={customerId} month={month} />
        ) : (
          <div className="text-[12px] text-ink-mute">No customer link — visit detail unavailable.</div>
        ))}

      {tab === "processing" && <Attempts attempts={attempts} />}
    </div>
  )
}

/** Credits the preprocessing step applied to this customer-month's invoices
 *  (unapplied maint prepayments + credit memos from the payments cache). */
function CreditsTable({ credits }: { credits: CreditsApplied }) {
  const rows = (credits ?? []).flatMap((c) =>
    c.applied_to.map((a) => ({
      kind: c.kind,
      source:
        c.kind === "credit_memo"
          ? `credit memo #${c.credit_memo_doc ?? c.credit_memo_id}`
          : `payment ${c.payment_id}`,
      doc: a.doc_number,
      amount: a.amount,
    })),
  )
  if (rows.length === 0) return null
  return (
    <Card className="max-w-2xl">
      <div className="px-4 py-2 bg-white/[0.02] border-b border-line-soft text-[11px] text-ink">
        Credits applied at preprocessing
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft/60">
            <th className="px-4 py-1.5 font-medium">Source</th>
            <th className="px-4 py-1.5 font-medium">Applied to</th>
            <th className="px-4 py-1.5 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line-soft/30 last:border-0 text-ink-dim">
              <td className="px-4 py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Pill tone={r.kind === "credit_memo" ? "indigo" : "teal"}>
                    {r.kind === "credit_memo" ? "memo" : "payment"}
                  </Pill>
                  <span className="font-mono">{r.source}</span>
                </span>
              </td>
              <td className="px-4 py-1.5 font-mono">#{r.doc ?? "?"}</td>
              <td className="px-4 py-1.5 text-right font-mono num text-grass">
                −{formatCurrency(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

const ATTEMPT_TONE: Record<string, "grass" | "teal" | "coral" | "sun" | "neutral"> = {
  charge_success: "grass",
  payment_created: "grass",
  completed: "grass",
  verified: "grass",
  pending: "sun",
  charge_failed: "coral",
  error: "coral",
}

function Attempts({ attempts }: { attempts: AttemptRow[] }) {
  if (attempts.length === 0) {
    return (
      <div className="text-[12px] text-ink-mute">
        No processing attempts for this customer-month yet.
      </div>
    )
  }
  return (
    <Card>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-mute border-b border-line-soft">
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Method</th>
            <th className="px-4 py-2 font-medium text-right">Amount</th>
            <th className="px-4 py-2 font-medium">Emails</th>
            <th className="px-4 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.id} className="border-b border-line-soft/40 last:border-0 align-top">
              <td className="px-4 py-2.5 font-mono text-xs text-ink-dim whitespace-nowrap">
                {a.created_at?.slice(0, 16).replace("T", " ")}
              </td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5">
                  <Pill tone={ATTEMPT_TONE[a.status ?? ""] ?? "neutral"} dot>
                    {a.status ?? "?"}
                  </Pill>
                  {a.dry_run && <Pill tone="neutral">dry run</Pill>}
                  {a.verified && <Pill tone="teal">verified</Pill>}
                </span>
              </td>
              <td className="px-4 py-2.5 text-ink-dim">
                {a.payment_method === "ach"
                  ? "ACH"
                  : a.card_type
                    ? `${a.card_type} ····${a.last_four ?? "?"}`
                    : "—"}
              </td>
              <td className="px-4 py-2.5 text-right font-mono num text-ink">
                {a.charge_amount != null ? formatCurrency(Number(a.charge_amount)) : "—"}
              </td>
              <td className="px-4 py-2.5 text-[11px] text-ink-mute">
                {a.receipt_emailed && "receipt "}
                {a.invoice_emailed && "invoice "}
                {!a.receipt_emailed && !a.invoice_emailed && "—"}
              </td>
              <td className="px-4 py-2.5 text-[11px]">
                {a.charge_error || a.error_message ? (
                  <span className="text-coral">
                    {a.error_step && `[${a.error_step}] `}
                    {a.charge_error ?? a.error_message}
                  </span>
                ) : a.qbo_payment_id ? (
                  <span className="text-ink-mute font-mono">payment {a.qbo_payment_id}</span>
                ) : (
                  <span className="text-ink-mute">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
