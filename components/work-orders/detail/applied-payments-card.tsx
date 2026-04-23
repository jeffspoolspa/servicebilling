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
 * The "Charge" column shows whether the payment actually ran through Intuit
 * Payments (has a CCTransId in raw.CreditCardPayment.CreditChargeResponse).
 * A green pill with the trans ID means money actually moved. A coral
 * "not charged" pill means it's a bookkeeping-only record (check, external
 * ACH, manually-entered card). Credit memos don't surface a charge pill
 * because they're issued credits, not money-in events.
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
              <th className="font-medium">Method</th>
              <th className="font-medium">Charge</th>
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
                <td className="text-ink-dim text-[11px]">
                  {p.payment_method_name ?? "—"}
                </td>
                <td>
                  <ChargePill
                    type={p.type}
                    wasCharged={p.was_charged}
                    ccTransId={p.cc_trans_id}
                    ccStatus={p.cc_status}
                    methodName={p.payment_method_name}
                  />
                </td>
                <td className="font-mono text-ink-dim text-[11px]">
                  {p.ref_num ?? "—"}
                </td>
                <td
                  className="text-ink-dim max-w-[220px] truncate"
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
        <span className="text-grass">charged</span> = Intuit completed the
        charge. <span className="text-coral">declined/pending/failed</span> =
        charge attempted but didn&apos;t complete.{" "}
        <span className="text-coral">not charged</span> = bookkeeping-only
        (cash, external ACH, manual card). Hover the pill for the Intuit
        transaction ID.
      </CardBody>
    </Card>
  )
}

function ChargePill({
  type,
  wasCharged,
  ccTransId,
  ccStatus,
  methodName,
}: {
  type: string | null
  wasCharged: boolean | null
  ccTransId: string | null
  ccStatus: string | null
  methodName: string | null
}) {
  // Credit memos aren't "charged" — they're issued credits.
  if (type === "credit_memo") {
    return <span className="text-ink-mute text-[11px]">—</span>
  }

  // True success requires BOTH: an Intuit CCTransId AND Status=Completed.
  // A CCTransId alone is just "we attempted a charge"; Status tells us if
  // money actually moved. Never mark Declined/Pending as "charged".
  if (wasCharged && ccTransId && ccStatus === "Completed") {
    return (
      <Pill
        tone="grass"
        dot
        className="text-[10px]"
        title={`Intuit CCTransId: ${ccTransId} · Completed`}
      >
        charged
      </Pill>
    )
  }

  // Charge attempt on file but didn't complete — Declined / Pending / etc.
  // This is the dangerous case the old code misclassified as "charged".
  if (wasCharged && ccTransId) {
    return (
      <Pill
        tone="coral"
        dot
        className="text-[10px]"
        title={`Intuit CCTransId: ${ccTransId}${ccStatus ? ` · ${ccStatus}` : " · status unknown"}`}
      >
        {ccStatus ? ccStatus.toLowerCase() : "failed"}
      </Pill>
    )
  }

  // Check = expected to be uncharged (bookkeeping only). Neutral so the
  // user doesn't mistake it for a problem.
  if (methodName && methodName.toLowerCase() === "check") {
    return (
      <span className="text-ink-mute text-[11px]" title="Check payments are bookkeeping-only — no Intuit charge expected.">
        check
      </span>
    )
  }

  // Cash, external ACH, manually-entered card — worth flagging at a glance.
  return (
    <Pill
      tone="coral"
      className="text-[10px]"
      title="No Intuit charge on file. Could be cash, external ACH, or a card entered manually without going through QBO Payments."
    >
      not charged
    </Pill>
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
