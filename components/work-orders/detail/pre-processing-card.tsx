import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import type { InvoiceDetail, WorkOrderDetail } from "@/lib/queries/dashboard"

/**
 * Sidebar card — persistent across tabs. Shows the four pre-processing
 * checkpoints + the review reason (if flagged). The user can see why an
 * invoice is stuck even while they're on the Work Order tab.
 *
 * The Credits row reconciles two signals (credits_applied jsonb and
 * needs_review_reason containing credit_review) so a "no matching credits"
 * green check never masks an unmatched-credit flag.
 */
export function PreProcessingCard({
  wo,
  invoice,
}: {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
}) {
  if (!invoice) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pre-processing</CardTitle>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          {wo.invoice_number
            ? "Invoice hasn't been pulled from QBO yet."
            : "No invoice number on this WO yet."}
        </CardBody>
      </Card>
    )
  }

  const reason = invoice.needs_review_reason ?? ""
  const hasCreditReview = /credit_review/i.test(reason)
  const applied = invoice.credits_applied ?? null
  const appliedSuccess = applied?.filter((c) => c.success) ?? []
  const appliedFailed = applied?.filter((c) => !c.success) ?? []

  let creditsState: boolean | null
  let creditsDetail: string
  if (hasCreditReview) {
    creditsState = false
    const m = reason.match(
      /credit_review \((\d+) unmatched credit\(s\), (\$[\d.]+) unapplied\)/,
    )
    creditsDetail = m
      ? `${m[1]} unmatched credit(s), ${m[2]} — review on Invoice tab`
      : "credits available but unmatched"
  } else if (applied == null) {
    creditsState = null
    creditsDetail = "not yet checked"
  } else if (applied.length === 0) {
    creditsState = true
    creditsDetail = "no applicable credits"
  } else {
    creditsState = applied.every((c) => c.success)
    const appliedTotal = appliedSuccess.reduce(
      (a, c) => a + Number(c.amount ?? 0),
      0,
    )
    creditsDetail =
      `${appliedSuccess.length} applied · ${formatCurrency(appliedTotal)}` +
      (appliedFailed.length > 0 ? ` · ${appliedFailed.length} failed` : "")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pre-processing</CardTitle>
        {invoice.pre_processed_at && (
          <span className="ml-auto text-[11px] text-ink-mute">
            {new Date(invoice.pre_processed_at).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        )}
      </CardHeader>
      <CardBody className="text-sm space-y-2">
        <CheckRow
          label="Subtotal"
          state={invoice.subtotal_ok}
          detail={
            invoice.subtotal_ok === false
              ? `WO ${formatCurrency(Number(wo.sub_total ?? 0))} vs QBO ${formatCurrency(Number(invoice.subtotal ?? 0))}`
              : invoice.subtotal_ok === true
                ? "matches"
                : "not yet checked"
          }
        />
        <CheckRow label="Credits" state={creditsState} detail={creditsDetail} />
        <CheckRow
          label="QBO enrichment"
          state={invoice.enrichment_ok}
          detail={
            invoice.enrichment_ok === false
              ? "memo / class issue"
              : invoice.enrichment_ok === true
                ? "written"
                : "not yet attempted"
          }
        />
        <CheckRow
          label="Payment method"
          state={invoice.payment_method ? true : null}
          detail={invoice.payment_method ?? "not yet resolved"}
        />
        {invoice.needs_review_reason && (
          <div className="mt-2 rounded border border-coral/30 bg-coral/5 px-3 py-2 text-[12px] text-coral">
            <div className="font-medium mb-0.5">Needs review</div>
            <div className="text-coral/80 text-[11px] break-words">
              {invoice.needs_review_reason}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function CheckRow({
  label,
  state,
  detail,
}: {
  label: string
  state: boolean | null
  detail: string
}) {
  const icon =
    state === true ? (
      <CheckCircle2 className="w-4 h-4 text-grass" strokeWidth={2} />
    ) : state === false ? (
      <XCircle className="w-4 h-4 text-coral" strokeWidth={2} />
    ) : (
      <AlertCircle className="w-4 h-4 text-ink-mute" strokeWidth={2} />
    )
  return (
    <div className="flex items-start gap-2">
      <div className="pt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-ink text-[13px]">{label}</div>
        <div className="text-ink-mute text-[11px]">{detail}</div>
      </div>
    </div>
  )
}
