import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import type { InvoiceHistoryEvent } from "@/lib/queries/dashboard"

/**
 * History tab — the per-invoice event log (public.invoice_history): every
 * pre-process run, process/charge attempt, credit decision event, and review
 * completion, newest first. This replaces the old pre-processing status card:
 * status lives inline next to the fields it describes; history lives here.
 */

const KIND_LABEL: Record<string, string> = {
  pre_process_run: "Pre-process run",
  process_attempt_process: "Process attempt",
  process_attempt_pre_process: "Pre-process attempt",
  credit_proposed: "Credit proposed",
  credit_applied: "Credit applied",
  credit_rejected: "Credit rejected",
  credit_candidate: "Credit considered",
  credit_stale: "Credit lapsed",
  review_completed: "Review completed",
}

const OUTCOME_TONE: Record<string, string> = {
  completed: "text-grass",
  succeeded: "text-grass",
  applied: "text-grass",
  running: "text-sun",
  queued: "text-ink-mute",
  proposed: "text-cyan",
  rejected: "text-ink-mute",
  failed: "text-coral",
  error: "text-coral",
  charge_declined: "text-coral",
  charge_uncertain: "text-sun",
  payment_orphan: "text-coral",
}

export function HistoryPanel({ events }: { events: InvoiceHistoryEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          No events yet — nothing has run against this invoice.
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
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
              <th className="px-5 py-2 font-medium">When</th>
              <th className="font-medium">Event</th>
              <th className="font-medium">Outcome</th>
              <th className="font-medium">Detail</th>
              <th className="num text-right font-medium">Amount</th>
              <th className="pr-5 font-medium">By</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i} className="border-b border-line-soft last:border-b-0">
                <td className="px-5 py-2 text-ink-mute whitespace-nowrap" title={e.at}>
                  {new Date(e.at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </td>
                <td className="py-2 pr-2 text-ink">
                  {KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")}
                </td>
                <td className={`py-2 pr-2 ${OUTCOME_TONE[e.outcome ?? ""] ?? "text-ink-dim"}`}>
                  {(e.outcome ?? "—").replace(/_/g, " ")}
                </td>
                <td
                  className="py-2 pr-2 text-ink-mute max-w-[280px] truncate"
                  title={e.detail ?? undefined}
                >
                  {e.detail || "—"}
                </td>
                <td className="py-2 pr-2 text-right num text-ink-dim">
                  {e.amount != null ? formatCurrency(Number(e.amount)) : "—"}
                </td>
                <td className="py-2 pr-5 text-ink-mute">{e.actor ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
