import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Coins,
  CheckCircle2,
  XCircle,
  RefreshCw,
  CreditCard,
  ClipboardCheck,
  CircleDot,
} from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import type { InvoiceHistoryEvent } from "@/lib/queries/dashboard"

/**
 * History — the invoice's activity feed. Reads public.invoice_history (the
 * projection over the operational fact tables — decisions, attempts, queue
 * runs, review stamps; each action writes ONE fact, the story is the union)
 * and renders each event as a sentence. Kind -> sentence templates live here;
 * the DB stays vocabulary-agnostic, so new event kinds render raw until given
 * a template (forward compatible).
 */

type Tone = "grass" | "coral" | "sun" | "cyan" | "mute"

const TONE_CLS: Record<Tone, string> = {
  grass: "text-grass",
  coral: "text-coral",
  sun: "text-sun",
  cyan: "text-cyan",
  mute: "text-ink-mute",
}

function describe(e: InvoiceHistoryEvent): {
  sentence: string
  tone: Tone
  Icon: typeof Coins
} {
  const amt = e.amount != null ? formatCurrency(Number(e.amount)) : null
  const reason = (e.detail ?? "").replace(/\s*\(credit [^)]+\)\s*/, "").trim()

  switch (e.kind) {
    case "credit_applied":
      return {
        sentence: `Applied ${amt ?? "a"} credit${
          e.actor === "auto" ? ` automatically${reason ? ` (${reason.replace(/_/g, " ")})` : ""}` : ""
        }${e.actor && e.actor !== "auto" ? ` — ${e.actor}` : ""}`,
        tone: "grass",
        Icon: Coins,
      }
    case "credit_rejected":
      return {
        sentence: `Marked ${amt ?? "a"} credit not applicable${
          e.actor === "review_complete" ? " (review completed)" : e.actor ? ` — ${e.actor}` : ""
        }`,
        tone: "mute",
        Icon: XCircle,
      }
    case "credit_proposed":
    case "credit_candidate":
      return {
        sentence: `Recommended ${amt ?? "a"} credit${reason ? ` (${reason.replace(/_/g, " ")})` : ""}`,
        tone: "cyan",
        Icon: CircleDot,
      }
    case "credit_stale":
      return { sentence: `Credit lapsed (${reason || "no longer available"})`, tone: "mute", Icon: XCircle }
    case "pre_process_run":
      return e.outcome === "failed"
        ? { sentence: `Pre-processing failed${e.detail ? ` — ${e.detail}` : ""}`, tone: "coral", Icon: RefreshCw }
        : e.outcome === "completed"
          ? { sentence: "Pre-processing ran (credits matched, memo & class written)", tone: "grass", Icon: RefreshCw }
          : { sentence: `Pre-processing ${e.outcome}`, tone: "sun", Icon: RefreshCw }
    case "process_attempt_process": {
      const via = e.actor ? ` via ${e.actor}` : ""
      switch (e.outcome) {
        case "succeeded":
          return { sentence: `Charged ${amt ?? ""}${via}`.trim(), tone: "grass", Icon: CreditCard }
        case "charge_declined":
          return { sentence: `Charge declined${via}${e.detail ? ` — ${e.detail}` : ""}`, tone: "coral", Icon: CreditCard }
        case "charge_uncertain":
          return { sentence: `Charge outcome uncertain${via} — reconciler will confirm`, tone: "sun", Icon: CreditCard }
        case "payment_orphan":
          return { sentence: "Charge succeeded but QBO payment failed to record — needs recovery", tone: "coral", Icon: CreditCard }
        default:
          return { sentence: `Process attempt: ${e.outcome ?? "unknown"}${e.detail ? ` — ${e.detail}` : ""}`, tone: "sun", Icon: CreditCard }
      }
    }
    case "review_completed":
      return { sentence: "Credit review completed", tone: "grass", Icon: ClipboardCheck }
    default:
      // unknown kind: render raw — forward compatible with new event arms
      return {
        sentence: `${e.kind.replace(/_/g, " ")}${e.outcome ? `: ${e.outcome}` : ""}`,
        tone: "mute",
        Icon: CircleDot,
      }
  }
}

export function HistoryPanel({ events }: { events: InvoiceHistoryEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          No activity yet — nothing has run against this invoice.
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <span className="ml-auto text-[11px] text-ink-mute">
          {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardBody className="py-1">
        <ol className="relative">
          {events.map((e, i) => {
            const { sentence, tone, Icon } = describe(e)
            return (
              <li
                key={i}
                className="flex items-start gap-3 py-2.5 border-b border-line-soft/60 last:border-b-0"
              >
                <span className={`mt-0.5 ${TONE_CLS[tone]}`}>
                  <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                </span>
                <span className="flex-1 min-w-0 text-[13px] text-ink leading-relaxed">
                  {sentence}
                </span>
                <span
                  className="text-[11px] text-ink-mute whitespace-nowrap"
                  title={new Date(e.at).toLocaleString()}
                >
                  {new Date(e.at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </li>
            )
          })}
        </ol>
      </CardBody>
    </Card>
  )
}
