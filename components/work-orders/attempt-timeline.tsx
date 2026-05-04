import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import type { ProcessAttempt } from "@/lib/queries/dashboard"
import { formatCurrency } from "@/lib/utils/format"
import { paymentChannel, paymentChannelShortLabel } from "@/lib/payment-channel"

/**
 * Vertical timeline of process attempts for a single invoice. Replaces
 * the single-attempt ProcessingCard so the user can see the full retry
 * history (succeeded → declined → reset → re-processed etc) in chronological
 * order, newest first.
 *
 * Layout:
 *   ◉  ───── status pill ───── timestamp
 *   │       channel · amount · charge_id
 *   │       error_message (if any)
 *   ◉  ─────  ...
 *
 * Each attempt is its own row anchored by a colored dot on the left.
 * The vertical line connects them. Dot color encodes status (green=succeeded,
 * yellow=mid-flight, coral=human-required, etc).
 */

function statusTone(
  status: string,
): "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" {
  switch (status) {
    case "succeeded":
      return "grass"
    case "charge_succeeded":
      return "sun" // charge ok, ledger pending
    case "pending":
    case "charge_uncertain":
      return "cyan"
    case "charge_uncertain_expired":
      return "sun"
    case "payment_orphan":
    case "needs_reconcile_review":
      return "coral"
    case "charge_declined":
    case "email_failed":
      return "sun"
    case "error":
      return "coral"
    default:
      return "neutral"
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ")
}

function dotColor(status: string): string {
  // Tailwind color tokens for the dot itself (the Pill takes care of label
  // styling; the dot is a free-standing marker in the timeline rail).
  switch (statusTone(status)) {
    case "grass":
      return "bg-grass border-grass"
    case "cyan":
      return "bg-cyan border-cyan"
    case "teal":
      return "bg-teal border-teal"
    case "sun":
      return "bg-sun border-sun"
    case "coral":
      return "bg-coral border-coral"
    default:
      return "bg-ink-mute border-ink-mute"
  }
}

function relativeTime(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return d.toLocaleDateString()
}

export function AttemptTimeline({
  attempts,
}: {
  attempts: ProcessAttempt[]
}) {
  if (attempts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Processing history</CardTitle>
          <Pill tone="neutral" className="ml-auto">
            not processed
          </Pill>
        </CardHeader>
        <CardBody className="text-ink-mute text-[13px]">
          No process attempts yet. Use{" "}
          <span className="text-ink">Process Selected</span> from the billing
          queue to charge / send this invoice.
        </CardBody>
      </Card>
    )
  }

  const latest = attempts[0]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing history</CardTitle>
        <span className="ml-auto text-[11px] text-ink-mute">
          {attempts.length} attempt{attempts.length === 1 ? "" : "s"}
        </span>
        <Pill tone={statusTone(latest.status)}>
          {statusLabel(latest.status)}
        </Pill>
      </CardHeader>
      <CardBody className="px-0 py-0">
        <ol className="relative">
          {attempts.map((a, i) => {
            const isLast = i === attempts.length - 1
            return (
              <li key={a.id} className="relative pl-12 pr-5 py-3">
                {/* Vertical line — drawn through every row except the last. */}
                {!isLast && (
                  <span
                    aria-hidden
                    className="absolute left-[1.6rem] top-[1.85rem] bottom-0 w-px bg-line-soft"
                  />
                )}
                {/* Dot marker. Sits on the line. */}
                <span
                  aria-hidden
                  className={`absolute left-[1.25rem] top-[1.1rem] w-2.5 h-2.5 rounded-full border-2 ${dotColor(a.status)}`}
                />
                <AttemptRow attempt={a} />
              </li>
            )
          })}
        </ol>
      </CardBody>
    </Card>
  )
}

function AttemptRow({ attempt }: { attempt: ProcessAttempt }) {
  const ch = paymentChannel(attempt)
  const chLabel = paymentChannelShortLabel(attempt)
  const isCharge = ch !== "email"

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={statusTone(attempt.status)}>
          {statusLabel(attempt.status)}
        </Pill>
        <span className="text-ink-mute text-[11px]">
          {chLabel}
          {isCharge && attempt.charge_amount != null && (
            <>
              {" · "}
              <span className="text-ink-dim font-mono">
                {formatCurrency(Number(attempt.charge_amount))}
              </span>
            </>
          )}
        </span>
        <span className="ml-auto text-ink-mute text-[11px]" title={new Date(attempt.attempted_at).toLocaleString()}>
          {relativeTime(attempt.attempted_at)}
        </span>
      </div>

      {/* Identifier rows — only render the ones that exist. Keeps the
          row dense for declines (no IDs) and rich for successes. */}
      {attempt.charge_id && (
        <IdRow label="Charge" value={attempt.charge_id} hint="Intuit Payments" />
      )}
      {attempt.qbo_payment_id && (
        <IdRow label="QBO Payment" value={attempt.qbo_payment_id} hint="Ledger record" />
      )}
      {attempt.email_sent === true && (
        <div className="text-[11px] text-ink-mute">Email sent ✓</div>
      )}

      {attempt.error_message && (
        <div className="text-[11px] text-coral/90 leading-relaxed break-words pt-1">
          {attempt.error_message}
        </div>
      )}
    </div>
  )
}

function IdRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-ink-mute">{label}</span>
      <code className="font-mono text-ink-dim text-[11px] truncate">{value}</code>
      {hint && <span className="text-ink-mute text-[10px]">{hint}</span>}
    </div>
  )
}
