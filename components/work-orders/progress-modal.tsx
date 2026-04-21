"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, X, Loader2, AlertTriangle, CreditCard, Mail, FileText, DollarSign, Tag, Search, Coins, Receipt } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"

/**
 * Live progress modal for pre-processing + processing runs.
 *
 * Pre-process mode: subscribes to billing.invoices (column `pre_process_stage`)
 *   and watches the row transition through stages. Script refactor writes
 *   each stage atomically so Realtime fires an UPDATE per step.
 *
 * Process mode: subscribes to billing.processing_attempts (latest row for this
 *   invoice, stage='process', dry_run=false) and transitions through
 *   `status` values: pending → charge_succeeded → succeeded (or halt states).
 *
 * The modal disables its own close while the job is actively running to
 * prevent the user from accidentally walking away mid-charge. On terminal
 * failure states (payment_orphan, charge_declined, email_failed,
 * memo errors) the modal flips to a failure card with retry options.
 *
 * Designed to be opened the instant the user fires an action — the modal
 * handles the async job completion, not the calling button.
 */

type Mode = "pre_process" | "process"

interface Stage {
  key: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}

const PRE_PROCESS_STAGES: Stage[] = [
  { key: "fetching_qbo", label: "Fetching from QBO", description: "Pull latest invoice + customer data", icon: Search },
  { key: "checking_subtotal", label: "Checking subtotal", description: "Compare WO subtotal vs QBO subtotal", icon: DollarSign },
  { key: "matching_credits", label: "Matching credits", description: "Auto-apply eligible unapplied payments", icon: Coins },
  { key: "resolving_payment_method", label: "Resolving payment method", description: "on_file / invoice", icon: CreditCard },
  { key: "deriving_class", label: "Deriving QBO class", description: "Service / Delivery / Maintenance / Renovation", icon: Tag },
  { key: "generating_memo", label: "Generating memo (Claude)", description: "Customer-friendly memo text", icon: FileText },
  { key: "writing_qbo", label: "Writing back to QBO", description: "PrivateNote, ClassRef, CustomerMemo", icon: Receipt },
]

const PROCESS_STAGES_ON_FILE: Stage[] = [
  { key: "pending", label: "Pre-flight", description: "Check prior attempts + write idempotency key", icon: Search },
  { key: "charge_succeeded", label: "Charging card", description: "Intuit Payments via Request-Id idempotency", icon: CreditCard },
  { key: "qbo_payment_id_set", label: "Recording payment in QBO", description: "Create QBO Payment linked to invoice", icon: Receipt },
  { key: "succeeded", label: "Sending emails", description: "Invoice + receipt", icon: Mail },
]

const PROCESS_STAGES_INVOICE: Stage[] = [
  { key: "pending", label: "Pre-flight", description: "Check prior attempts + write idempotency key", icon: Search },
  { key: "succeeded", label: "Sending invoice email", description: "via QBO", icon: Mail },
]

type StageState = "pending" | "active" | "done" | "failed" | "skipped"

interface Props {
  open: boolean
  onClose: () => void
  qboInvoiceId: string
  mode: Mode
  /** For process mode: helps pick the right stage list and confirmation text. */
  paymentMethod?: "on_file" | "invoice" | null
  /** Stages of the caller - used to detect that processing actually STARTED.
   *  Modal opens before the script fires, so we need to wait for first Realtime
   *  event to flip from "queued" → active. */
  triggeredAt?: number
}

export function ProgressModal({
  open,
  onClose,
  qboInvoiceId,
  mode,
  paymentMethod,
  triggeredAt,
}: Props) {
  const router = useRouter()
  const [currentStage, setCurrentStage] = useState<string | null>(null)
  const [status, setStatus] = useState<"running" | "done" | "failed">("running")
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const [invoiceBillingStatus, setInvoiceBillingStatus] = useState<string | null>(null)
  const [invoiceNeedsReason, setInvoiceNeedsReason] = useState<string | null>(null)
  const channelRef = useRef<ReturnType<ReturnType<typeof createSupabaseBrowser>["channel"]> | null>(null)

  const stages: Stage[] = useMemo(() => {
    if (mode === "pre_process") return PRE_PROCESS_STAGES
    return paymentMethod === "on_file" ? PROCESS_STAGES_ON_FILE : PROCESS_STAGES_INVOICE
  }, [mode, paymentMethod])

  // Reset when modal re-opens (allows reuse across multiple runs)
  useEffect(() => {
    if (open) {
      setCurrentStage(null)
      setStatus("running")
      setFailureReason(null)
      setInvoiceBillingStatus(null)
      setInvoiceNeedsReason(null)
    }
  }, [open, triggeredAt])

  // Watch DB state while modal is open. Strategy:
  //   - Realtime subscription for instant animation when events arrive
  //   - Polling fallback every 1.5s as a guarantee — if Realtime is flaky,
  //     UI still updates within a second or two of DB state changes
  // Both paths converge on the same apply*Row() reducers so there's no race.
  useEffect(() => {
    if (!open) return
    const sb = createSupabaseBrowser()
    let cancelled = false

    async function seed() {
      if (cancelled) return
      if (mode === "pre_process") {
        const { data } = await sb
          .from("billing_invoices")
          .select("pre_process_stage, billing_status, needs_review_reason")
          .eq("qbo_invoice_id", qboInvoiceId)
          .maybeSingle()
        if (data && !cancelled) {
          applyInvoiceRow(data as Record<string, unknown>)
        }
      } else {
        const { data } = await sb
          .from("billing_processing_attempts")
          .select("status, charge_id, qbo_payment_id, email_sent, error_message, attempted_at, dry_run, stage")
          .eq("qbo_invoice_id", qboInvoiceId)
          .eq("stage", "process")
          .eq("dry_run", false)
          .order("attempted_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (data && !cancelled) {
          applyAttemptRow(data as Record<string, unknown>)
        }
      }
    }

    // Kick off immediately + every 1.5s
    seed()
    const pollInterval = setInterval(seed, 1500)

    // Realtime subscription — instant updates when events arrive
    const channel = sb
      .channel(`progress-${mode}-${qboInvoiceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "billing",
          table: mode === "pre_process" ? "invoices" : "processing_attempts",
          filter: `qbo_invoice_id=eq.${qboInvoiceId}`,
        },
        (payload) => {
          const newRow = (payload as unknown as { new?: Record<string, unknown> }).new
          const row = (newRow ?? {}) as Record<string, unknown>
          if (mode === "pre_process") {
            applyInvoiceRow(row)
          } else {
            if (row.dry_run === true) return
            if (row.stage !== "process") return
            applyAttemptRow(row)
          }
        },
      )
      .subscribe()

    channelRef.current = channel
    return () => {
      cancelled = true
      clearInterval(pollInterval)
      channel.unsubscribe()
      channelRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, qboInvoiceId, mode])

  function applyInvoiceRow(row: Record<string, unknown>) {
    const stage = (row.pre_process_stage as string | null) ?? null
    const billingStatus = (row.billing_status as string | null) ?? null
    const reason = (row.needs_review_reason as string | null) ?? null
    setInvoiceBillingStatus(billingStatus)
    setInvoiceNeedsReason(reason)
    if (stage === "done" || billingStatus === "ready_to_process" || billingStatus === "processed") {
      setCurrentStage("done")
      setStatus("done")
    } else if (billingStatus === "needs_review" && stage === "done") {
      setCurrentStage("done")
      setStatus("failed")
      setFailureReason(reason)
    } else if (stage) {
      setCurrentStage(stage)
    }
  }

  function applyAttemptRow(row: Record<string, unknown>) {
    const attemptStatus = (row.status as string | null) ?? null
    const chargeId = (row.charge_id as string | null) ?? null
    const qboPaymentId = (row.qbo_payment_id as string | null) ?? null
    const emailSent = row.email_sent === true
    const errorMsg = (row.error_message as string | null) ?? null

    // Map attempt.status to a stage key — some stages are derived
    let stage: string | null = null
    if (attemptStatus === "pending") stage = "pending"
    else if (attemptStatus === "charge_succeeded") stage = qboPaymentId ? "qbo_payment_id_set" : "charge_succeeded"
    else if (attemptStatus === "succeeded") stage = "succeeded"

    if (stage) setCurrentStage(stage)

    if (attemptStatus === "succeeded") {
      setStatus("done")
    } else if (
      attemptStatus === "charge_declined" ||
      attemptStatus === "payment_orphan" ||
      attemptStatus === "email_failed" ||
      attemptStatus === "charge_uncertain" ||
      attemptStatus === "error"
    ) {
      setStatus("failed")
      setFailureReason(errorMsg ?? attemptStatus)
    }
  }

  // Derive per-stage state from the current cursor
  function stageState(stageKey: string): StageState {
    if (!currentStage) return "pending"
    const idx = stages.findIndex((s) => s.key === stageKey)
    const curIdx = currentStage === "done"
      ? stages.length
      : stages.findIndex((s) => s.key === currentStage)
    if (curIdx === -1) return "pending"
    if (idx < curIdx) return "done"
    if (idx === curIdx) {
      if (status === "failed") return "failed"
      if (status === "done") return "done"
      return "active"
    }
    return "pending"
  }

  if (!open) return null

  const isDone = status === "done"
  const isFailed = status === "failed"
  const canClose = isDone || isFailed

  return (
    <div
      className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) {
          router.refresh()
          onClose()
        }
      }}
    >
      <div className="bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-lg w-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <div>
            <div className="text-sm font-medium text-ink">
              {mode === "pre_process" ? "Pre-processing invoice" : "Processing invoice"}
            </div>
            <div className="text-[11px] text-ink-mute font-mono mt-0.5">
              {qboInvoiceId}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status === "running" && (
              <>
                <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
                <span className="text-[11px] text-cyan">live</span>
              </>
            )}
            {isDone && (
              <>
                <Check className="w-4 h-4 text-grass" strokeWidth={2.5} />
                <span className="text-[11px] text-grass">done</span>
              </>
            )}
            {isFailed && (
              <>
                <AlertTriangle className="w-4 h-4 text-coral" strokeWidth={2} />
                <span className="text-[11px] text-coral">failed</span>
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-4 space-y-1">
          {stages.map((s, i) => {
            const st = stageState(s.key)
            return (
              <StageRow
                key={s.key}
                stage={s}
                state={st}
                isLast={i === stages.length - 1}
              />
            )
          })}
        </div>

        {isFailed && failureReason && (
          <div className="px-5 py-3 border-t border-line-soft bg-coral/[0.04]">
            <div className="text-[11px] uppercase tracking-[0.08em] text-coral/80 mb-1">
              failure reason
            </div>
            <div className="text-[12px] text-ink-dim break-words">{failureReason}</div>
          </div>
        )}

        {isDone && mode === "pre_process" && invoiceBillingStatus === "needs_review" && (
          <div className="px-5 py-3 border-t border-line-soft bg-sun/[0.04]">
            <div className="text-[11px] uppercase tracking-[0.08em] text-sun/80 mb-1">
              landed in needs_review
            </div>
            <div className="text-[12px] text-ink-dim break-words">
              {invoiceNeedsReason ?? "see detail page for review reason"}
            </div>
          </div>
        )}

        <div className="px-5 py-4 border-t border-line-soft flex justify-end gap-2">
          <Button
            size="sm"
            variant={canClose ? "default" : "ghost"}
            disabled={!canClose}
            onClick={() => {
              router.refresh()
              onClose()
            }}
            title={!canClose ? "Wait until the run finishes" : undefined}
          >
            {canClose ? "Close" : "Running..."}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StageRow({ stage, state, isLast }: { stage: Stage; state: StageState; isLast: boolean }) {
  const Icon = stage.icon
  const color =
    state === "done"
      ? "text-grass"
      : state === "active"
        ? "text-cyan"
        : state === "failed"
          ? "text-coral"
          : state === "skipped"
            ? "text-ink-mute"
            : "text-ink-mute/50"

  const bg =
    state === "done"
      ? "bg-grass/15 border-grass/40"
      : state === "active"
        ? "bg-cyan/15 border-cyan/50 ring-2 ring-cyan/30 ring-offset-0 animate-pulse"
        : state === "failed"
          ? "bg-coral/15 border-coral/50"
          : "bg-bg-elev border-line"

  return (
    <div className="flex items-start gap-3 py-2">
      <div className="relative flex flex-col items-center">
        <div
          className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-300 ${bg}`}
        >
          {state === "done" ? (
            <Check className={`w-4 h-4 ${color}`} strokeWidth={2.5} />
          ) : state === "active" ? (
            <Loader2 className={`w-3.5 h-3.5 ${color} animate-spin`} strokeWidth={2} />
          ) : state === "failed" ? (
            <X className={`w-4 h-4 ${color}`} strokeWidth={2.5} />
          ) : (
            <Icon className={`w-3.5 h-3.5 ${color}`} strokeWidth={1.8} />
          )}
        </div>
        {!isLast && (
          <div
            className={`w-px flex-1 min-h-[16px] mt-1 ${state === "done" ? "bg-grass/40" : "bg-line"}`}
          />
        )}
      </div>
      <div className="flex-1 pt-1 pb-2">
        <div
          className={`text-sm transition-colors ${
            state === "done"
              ? "text-ink"
              : state === "active"
                ? "text-ink"
                : state === "failed"
                  ? "text-coral"
                  : "text-ink-mute"
          }`}
        >
          {stage.label}
        </div>
        <div className="text-[11px] text-ink-mute">{stage.description}</div>
      </div>
    </div>
  )
}
