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
 * (public.service_billing_state) and renders three zones:
 *
 *   1. state header  — where the invoice is (pre_process_state, falling back
 *                      to derived_status until the projection consolidation)
 *   2. gates         — why it isn't further along (subtotal / credits /
 *                      enrichment / payment route), each a typed fact —
 *                      no needs_review_reason string parsing
 *   3. provenance    — can the decision be trusted (credits_verified_at /
 *                      invoice mirror age / review completion)
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

  // Zone 1 — the state pill. pre_process_state is authoritative once the new
  // worker has touched the invoice; older invoices fall back to derived_status.
  const effState = state.pre_process_state ?? state.derived_status ?? "unknown"
  const stateMeta: Record<string, { label: string; tone: "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" }> = {
    deciding: { label: "deciding", tone: "sun" },
    awaiting_pre_processing: { label: "awaiting", tone: "neutral" },
    needs_review: { label: "needs review", tone: "coral" },
    ready_to_process: { label: "ready", tone: "cyan" },
    processing: { label: "processing", tone: "teal" },
    processed: { label: "processed", tone: "grass" },
    open_ar: { label: "open AR", tone: "sun" },
  }
  const pill = stateMeta[effState] ?? { label: effState, tone: "neutral" as const }

  // Zone 2 — gates from typed facts.
  const decisionsExist =
    state.open_candidate_count + state.applied_count +
    state.rejected_count + state.stale_count > 0

  let creditsState: boolean | null
  let creditsDetail: string
  if (!state.credits_settled) {
    creditsState = false
    creditsDetail = `${state.open_candidate_count} to decide — review on Invoice tab`
  } else if (decisionsExist) {
    creditsState = true
    const parts: string[] = []
    if (state.applied_count > 0)
      parts.push(`${state.applied_count} applied · ${formatCurrency(Number(state.credits_applied_amount))}`)
    if (state.rejected_count > 0) parts.push(`${state.rejected_count} rejected`)
    if (state.stale_count > 0) parts.push(`${state.stale_count} stale`)
    creditsDetail = parts.join(" · ") || "settled"
  } else if (state.pre_processed_at) {
    creditsState = true
    creditsDetail = "no applicable credits"
  } else {
    creditsState = null
    creditsDetail = "not yet checked"
  }

  const route = state.preferred_payment_type ?? state.payment_method

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pre-processing</CardTitle>
        <div className="ml-auto flex items-center gap-2">
          <Pill tone={pill.tone} dot>
            {pill.label}
          </Pill>
        </div>
      </CardHeader>
      <CardBody className="text-sm space-y-2">
        <CheckRow
          label="Subtotal"
          state={state.subtotal_ok}
          detail={
            state.subtotal_ok === false
              ? `WO ${formatCurrency(Number(wo.sub_total ?? 0))} vs QBO ${formatCurrency(Number(state.subtotal ?? 0))}`
              : state.subtotal_ok === true
                ? "matches"
                : "not yet checked"
          }
        />
        <CheckRow label="Credits" state={creditsState} detail={creditsDetail} />
        <CheckRow
          label="QBO enrichment"
          state={state.enrichment_ok}
          detail={
            state.enrichment_ok === false
              ? "memo / class issue"
              : state.enrichment_ok === true
                ? "written"
                : "not yet attempted"
          }
        />
        <CheckRow
          label="Payment route"
          state={route ? true : null}
          detail={route ?? "not yet resolved"}
        />

        {state.needs_review_reason && (
          <div className="mt-2 rounded border border-coral/30 bg-coral/5 px-3 py-2 text-[12px] text-coral">
            <div className="font-medium mb-0.5">Needs review</div>
            <div className="text-coral/80 text-[11px] break-words">
              {state.needs_review_reason}
            </div>
          </div>
        )}

        {/* Zone 3 — freshness provenance: what evidence backed the decision. */}
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
