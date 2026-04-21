import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Coins } from "lucide-react"
import type { AppliedPayment } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Applied credits/payments on this invoice. Data source: the
 * billing.payment_invoice_links table, populated by:
 *   - pull_qbo_credits    → applied_via='external_qbo' (found in QBO raw)
 *   - pre_process         → applied_via='auto_match'   (our auto-matching rules)
 *   - apply_credit_manual → applied_via='manual'       (user clicked Apply)
 *
 * Links survive pre_process re-runs, so the history stays intact even as
 * credits_applied jsonb gets rewritten.
 */
export function AppliedPaymentsCard({
  payments,
}: {
  payments: AppliedPayment[]
}) {
  if (payments.length === 0) return null

  const total = payments.reduce((a, p) => a + Number(p.amount ?? 0), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Applied payments</CardTitle>
        <span className="ml-auto text-[11px] text-ink-mute">
          {payments.length} · {formatCurrency(total)}
        </span>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
              <th className="px-5 py-2 font-medium">Type</th>
              <th className="font-medium">Ref</th>
              <th className="font-medium">Memo</th>
              <th className="font-medium">Source</th>
              <th className="font-medium">Applied</th>
              <th className="num text-right pr-5 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr
                key={p.payment_id}
                className="border-b border-line-soft last:border-b-0"
              >
                <td className="px-5 py-2 text-ink-dim">
                  <span className="inline-flex items-center gap-1.5">
                    <Coins className="w-3 h-3 text-ink-mute" strokeWidth={1.8} />
                    {p.type === "credit_memo" ? "Credit memo" : "Payment"}
                  </span>
                </td>
                <td className="font-mono text-ink-dim text-[11px]">
                  {p.ref_num ?? "—"}
                </td>
                <td
                  className="text-ink-dim max-w-[260px] truncate"
                  title={p.memo ?? undefined}
                >
                  {p.memo ?? "—"}
                </td>
                <td>
                  <SourcePill via={p.applied_via} />
                </td>
                <td className="text-ink-mute text-[11px]">
                  {formatDate(p.applied_at)}
                </td>
                <td className="num text-right pr-5 text-ink font-medium">
                  {formatCurrency(Number(p.amount ?? 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CardBody className="border-t border-line-soft text-[11px] text-ink-mute">
        QBO is the source of truth. Amounts reflect what was captured in QBO
        at the time of the link; refresh the invoice from QBO to verify current state.
      </CardBody>
    </Card>
  )
}

function SourcePill({ via }: { via: string }) {
  const map: Record<string, { label: string; tone: "teal" | "cyan" | "neutral" | "sun" }> = {
    manual: { label: "manual", tone: "cyan" },
    auto_match: { label: "auto-match", tone: "teal" },
    external_qbo: { label: "in QBO", tone: "neutral" },
    seed_backfill: { label: "backfill", tone: "neutral" },
  }
  const info = map[via] ?? { label: via, tone: "neutral" as const }
  return (
    <Pill tone={info.tone} className="text-[10px]">
      {info.label}
    </Pill>
  )
}
