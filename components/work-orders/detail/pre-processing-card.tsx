import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import type {
  InvoiceDetail,
  ServiceBillingState,
  WorkOrderDetail,
} from "@/lib/queries/dashboard"

/**
 * Sidebar card — persistent across tabs. Reads ONE row
 * (public.service_billing_state, derived readiness v3) and renders:
 *
 *   1. ready pill    — billing.invoice_ready(), the one rule function
 *   2. rule lights   — one row per rule, each a named boolean from the view
 *                      (no needs_review_reason string parsing; adding a rule
 *                      = adding a column + a row here)
 *   3. provenance    — what evidence backed the decision (credits verified /
 *                      invoice mirror age / review completed / last run)
 */
export function PreProcessingCard({
  wo,
  invoice,
  state,
}: {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
  state: ServiceBillingState | null
}) {
  if (!invoice || !state) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pre-processing</CardTitle>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          {wo.invoice_number
            ? "Invoice hasn't landed from QBO yet (webhook + sync will pick it up)."
            : "No invoice number on this WO yet."}
        </CardBody>
      </Card>
    )
  }

  // credits detail from the decision rollup (typed facts, no parsing)
  let creditsDetail: string
  if (!state.credits_settled) {
    creditsDetail = `${state.undecided_credit_count} to decide — review on Invoice tab`
  } else if (state.applied_count + state.rejected_count > 0) {
    const parts: string[] = []
    if (state.applied_count > 0)
      parts.push(
        `${state.applied_count} applied · ${formatCurrency(Number(state.credits_applied_amount))}`,
      )
    if (state.rejected_count > 0) parts.push(`${state.rejected_count} rejected`)
    creditsDetail = parts.join(" · ")
  } else {
    creditsDetail = "no applicable credits"
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pre-processing</CardTitle>
        <div className="ml-auto flex items-center gap-2">
          {state.ready ? (
            <Pill tone="cyan" dot>
              ready
            </Pill>
          ) : (
            <Pill tone={state.derived_status === "needs_review" ? "coral" : "sun"} dot>
              {state.derived_status === "needs_review" ? "needs review" : "not ready"}
            </Pill>
          )}
        </div>
      </CardHeader>
      <CardBody className="text-sm space-y-2">
        <CheckRow
          label="Pre-process run"
          state={state.run_complete}
          detail={state.run_complete ? "completed" : "not yet run (or failed)"}
        />
        <CheckRow
          label="Subtotal"
          state={state.subtotal_matches}
          detail={
            state.subtotal_matches
              ? "matches WO"
              : `WO ${formatCurrency(Number(wo.sub_total ?? 0))} vs QBO ${formatCurrency(Number(state.subtotal ?? 0))}`
          }
        />
        <CheckRow label="Credits" state={state.credits_settled} detail={creditsDetail} />
        <CheckRow
          label="Memo & class"
          state={state.memo_present && state.class_present}
          detail={
            state.memo_present && state.class_present
              ? "written"
              : [
                  !state.memo_present && "memo missing",
                  !state.class_present && "class missing",
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
        />
        <CheckRow
          label="Due date"
          state={state.due_date_ok}
          detail={
            state.due_date_ok
              ? "current"
              : "past — first send blocked (delivery guard)"
          }
        />
        <CheckRow
          label="Payment route"
          state={state.pm_resolved}
          detail={
            state.payment_route
              ? state.payment_route +
                (state.pm_resolved ? "" : " — no matching method on file")
              : "not resolvable"
          }
        />

        {state.needs_review_reason && (
          <div className="mt-2 rounded border border-coral/30 bg-coral/5 px-3 py-2 text-[12px] text-coral">
            <div className="font-medium mb-0.5">Needs review</div>
            <div className="text-coral/80 text-[11px] break-words">
              {state.needs_review_reason}
            </div>
          </div>
        )}

        {/* provenance: what evidence backed the decision */}
        <div className="pt-2 border-t border-line-soft text-[10px] text-ink-mute space-y-0.5">
          <ProvRow
            label="Credits verified"
            at={state.credits_verified_at}
            fallback={
              state.pre_processed_at
                ? "decided without confirmed fresh read"
                : "pending first run"
            }
          />
          <ProvRow label="Invoice mirror" at={state.invoice_verified_at} fallback="never" />
          {state.reviewed_at && <ProvRow label="Review completed" at={state.reviewed_at} fallback="" />}
          {state.pre_processed_at && (
            <ProvRow label="Last pre-process" at={state.pre_processed_at} fallback="" />
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function ProvRow({
  label,
  at,
  fallback,
}: {
  label: string
  at: string | null
  fallback: string
}) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span
        className={at ? "text-ink-dim" : "text-sun"}
        title={at ? new Date(at).toLocaleString() : undefined}
        suppressHydrationWarning
      >
        {at ? relTime(at) : fallback}
      </span>
    </div>
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
