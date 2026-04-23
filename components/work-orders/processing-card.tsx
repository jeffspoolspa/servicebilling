import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import type { ProcessAttempt } from "@/lib/queries/dashboard"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Processing card on the WO detail page.
 * Shows the most recent (non-dry-run) process attempt + its status.
 * RecoveryBanner is rendered separately at the top of the page for high visibility.
 *
 * Shape summary:
 *   No attempt yet → compact "not processed" pill + hint.
 *   pending / charge_uncertain → currently in flight or uncertain.
 *   charge_succeeded → charge went through, ledger write pending.
 *   payment_orphan → banner handled at top of page.
 *   charge_declined → banner handled at top of page.
 *   email_failed → banner handled at top of page.
 *   succeeded → green pill with charge_id + qbo_payment_id + amount.
 */

function statusTone(
  status: string,
): "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" {
  switch (status) {
    case "succeeded":
      return "grass"
    case "charge_succeeded":
      return "sun" // mid-flight OK
    case "pending":
    case "charge_uncertain":
      return "cyan"
    case "payment_orphan":
      return "coral"
    case "charge_declined":
    case "email_failed":
      return "sun"
    default:
      return "neutral"
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ")
}

export function ProcessingCard({
  attempt,
}: {
  attempt: ProcessAttempt | null
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Processing</CardTitle>
          {attempt ? (
            <Pill tone={statusTone(attempt.status)} className="ml-auto">
              {statusLabel(attempt.status)}
            </Pill>
          ) : (
            <Pill tone="neutral" className="ml-auto">
              not processed
            </Pill>
          )}
        </CardHeader>
        <CardBody className="text-sm space-y-2">
          {!attempt ? (
            <div className="text-ink-mute text-[13px]">
              No process attempt yet. Use <span className="text-ink">Process Selected</span>{" "}
              from the billing queue to charge / send this invoice.
            </div>
          ) : (
            <>
              <Row label="Attempted" value={new Date(attempt.attempted_at).toLocaleString()} />
              <Row label="Payment method" value={attempt.payment_method ?? "—"} />
              {/* Charge row — surfaces the charge outcome with the right
                  context. Three paths:
                  1. Card charged → show Amount + Charge ID
                  2. Invoice-email path (no charge by design) → explicit note
                  3. on_file but zero balance (credit-covered / paid externally)
                     → explicit "skipped" note */}
              {attempt.charge_id ? (
                <>
                  <Row
                    label="Amount charged"
                    value={
                      attempt.charge_amount != null
                        ? formatCurrency(Number(attempt.charge_amount))
                        : "—"
                    }
                    mono
                  />
                  <Row
                    label="Charge ID"
                    value={attempt.charge_id}
                    mono
                    hint="Intuit Payments reference"
                  />
                </>
              ) : attempt.payment_method === "invoice" ? (
                <Row
                  label="Charge"
                  value="n/a — invoice email only"
                />
              ) : Number(attempt.charge_amount ?? 0) === 0 ? (
                <Row
                  label="Charge"
                  value="skipped — no balance to collect"
                />
              ) : null}
              {attempt.qbo_payment_id && (
                <Row
                  label="QBO Payment ID"
                  value={attempt.qbo_payment_id}
                  mono
                  hint="Ledger record"
                />
              )}
              {attempt.email_sent != null && (
                <Row
                  label="Email"
                  value={attempt.email_sent ? "sent" : "not sent"}
                />
              )}
              {attempt.error_message && (
                <div className="pt-2 text-coral/90 text-[11px] leading-relaxed break-words">
                  {attempt.error_message}
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </>
  )
}

function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string
  value: string
  mono?: boolean
  hint?: string
}) {
  return (
    <div className="flex justify-between gap-3 items-start">
      <div className="flex flex-col">
        <span className="text-ink-mute">{label}</span>
        {hint && <span className="text-ink-mute text-[10px]">{hint}</span>}
      </div>
      <span
        className={`${mono ? "font-mono text-xs" : ""} text-ink-dim text-right break-all max-w-[60%]`}
      >
        {value}
      </span>
    </div>
  )
}
