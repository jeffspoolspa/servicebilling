"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  X,
  Loader2,
  AlertTriangle,
  CreditCard,
  Mail,
  Receipt,
  Clock,
} from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * Live processing tracker for maintenance charge runs — fire-and-forget (the
 * route returns a jobId immediately) with progress read from the DB rows the
 * engine writes. Presented as an activity CHIP + small anchored panel (same
 * pattern as the preprocess QueueChip), not a screen-takeover: the chip shows
 * "Processing · resolved/total" while the run lives, click toggles the row
 * list, and dismissing never aborts anything (the run is server-side).
 *
 * Feeds: billing_processing_attempts view (stage='maint', run-scoped) for
 * per-invoice stage detail, and maint_billing_period_statuses for the
 * authoritative finished signal (also resolves already-emailed rows that
 * never create an attempt).
 */

export interface RunItem {
  period_id: string
  doc_number: string | null
  customer_name: string
}

interface AttemptRow {
  invoice_number: string | null
  status: string | null
  charge_amount: number | null
  qbo_payment_id: string | null
  error_message: string | null
  attempted_at: string
}

interface PeriodStatus {
  id: string
  processing_status: string
  qbo_balance: number | null
}

type RowState =
  | { kind: "queued" }
  | { kind: "running"; label: string }
  | { kind: "done"; label: string; detail?: string }
  | { kind: "warn"; label: string; detail?: string }
  | { kind: "failed"; label: string; detail?: string }

function deriveState(
  attempt: AttemptRow | undefined,
  period: PeriodStatus | undefined,
  running: boolean,
): RowState {
  const processed = period?.processing_status === "processed"
  const paid = period?.qbo_balance != null && period.qbo_balance <= 0
  const amt =
    attempt?.charge_amount != null ? `$${Number(attempt.charge_amount).toFixed(2)}` : null

  if (attempt) {
    switch (attempt.status) {
      case "pending":
        return { kind: "running", label: "charging…" }
      case "charge_succeeded":
        return attempt.qbo_payment_id
          ? { kind: "running", label: "sending emails…" }
          : { kind: "running", label: "recording payment…" }
      case "succeeded":
        return { kind: "done", label: "succeeded", detail: amt ? `${amt} charged` : undefined }
      case "charge_declined":
        return processed
          ? {
              kind: "warn",
              label: "declined → invoiced → processed",
              detail: attempt.error_message ?? undefined,
            }
          : running
            ? { kind: "running", label: "declined — sending invoice…" }
            : { kind: "warn", label: "declined", detail: attempt.error_message ?? undefined }
      case "email_failed":
        return { kind: "warn", label: "email failed", detail: attempt.error_message ?? undefined }
      case "charge_uncertain":
        return {
          kind: "failed",
          label: "charge uncertain — halted",
          detail: attempt.error_message ?? undefined,
        }
      case "payment_orphan":
        return {
          kind: "failed",
          label: "payment orphan — needs recovery",
          detail: attempt.error_message ?? undefined,
        }
      case "error":
        return { kind: "failed", label: "error", detail: attempt.error_message ?? undefined }
    }
  }
  if (processed) {
    return { kind: "done", label: paid ? "processed · paid" : "processed · invoice out" }
  }
  return running ? { kind: "queued" } : { kind: "warn", label: "not processed" }
}

function isResolved(st: RowState): boolean {
  return st.kind === "done" || st.kind === "failed" || st.kind === "warn"
}

export function MaintRunTracker({
  items,
  runError,
  fired,
  onDismiss,
}: {
  items: RunItem[]
  runError: string | null
  fired: boolean
  onDismiss: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(true)
  const [attempts, setAttempts] = useState<Map<string, AttemptRow>>(new Map())
  const [periods, setPeriods] = useState<Map<string, PeriodStatus>>(new Map())
  const panelRef = useRef<HTMLDivElement | null>(null)
  const startedAtRef = useRef<string>(new Date().toISOString())
  const refreshedRef = useRef(false)

  const states = useMemo(() => {
    const running = fired && !runError
    return items.map((item) => {
      const attempt = item.doc_number ? attempts.get(item.doc_number) : undefined
      const period = periods.get(item.period_id)
      return { item, state: deriveState(attempt, period, running) }
    })
  }, [items, attempts, periods, fired, runError])

  const resolved = states.filter(({ state }) => isResolved(state)).length
  const allResolved = states.length > 0 && resolved === states.length
  const running = fired && !runError && !allResolved

  // refresh the page data once when the run completes
  useEffect(() => {
    if (allResolved && !refreshedRef.current) {
      refreshedRef.current = true
      router.refresh()
    }
  }, [allResolved, router])

  useEffect(() => {
    if (!running) return
    const sb = createSupabaseBrowser()
    const docs = items.map((i) => i.doc_number).filter(Boolean) as string[]
    const periodIds = items.map((i) => i.period_id)
    let cancelled = false

    const applyAttempts = (rows: AttemptRow[]) => {
      if (cancelled || rows.length === 0) return
      setAttempts((prev) => {
        const next = new Map(prev)
        for (const r of rows) {
          if (!r.invoice_number) continue
          const cur = next.get(r.invoice_number)
          if (!cur || r.attempted_at >= cur.attempted_at) next.set(r.invoice_number, r)
        }
        return next
      })
    }

    async function poll() {
      const [attemptRes, periodRes] = await Promise.all([
        docs.length > 0
          ? sb
              .from("billing_processing_attempts")
              .select(
                "invoice_number, status, charge_amount, qbo_payment_id, error_message, attempted_at",
              )
              .in("invoice_number", docs)
              .eq("stage", "maint")
              .eq("dry_run", false)
              .gte("attempted_at", startedAtRef.current)
          : Promise.resolve({ data: [] }),
        sb.rpc("maint_billing_period_statuses", { p_ids: periodIds }),
      ])
      if (cancelled) return
      if (attemptRes.data) applyAttempts(attemptRes.data as AttemptRow[])
      if (periodRes.data) {
        setPeriods(new Map((periodRes.data as PeriodStatus[]).map((p) => [p.id, p])))
      }
    }
    poll()
    const interval = setInterval(poll, 1500)

    const channel = sb
      .channel(`maint-process-${startedAtRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "billing", table: "processing_attempts" },
        (payload) => {
          const row = ((payload as unknown as { new?: Record<string, unknown> }).new ??
            {}) as Record<string, unknown>
          if (row.stage !== "maint" || row.dry_run === true) return
          if (!docs.includes((row.invoice_number as string) ?? "")) return
          applyAttempts([row as unknown as AttemptRow])
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      clearInterval(interval)
      channel.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  if (items.length === 0) return null

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-colors ${
          runError
            ? "border-coral/40 bg-coral/10 text-coral hover:bg-coral/20"
            : running
              ? "border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20"
              : "border-grass/30 bg-grass/10 text-grass hover:bg-grass/20"
        }`}
      >
        {runError ? (
          <AlertTriangle className="w-3 h-3" strokeWidth={2} />
        ) : running ? (
          <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
        ) : (
          <Check className="w-3 h-3" strokeWidth={2.5} />
        )}
        Processing · {resolved}/{items.length}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[26rem] z-30 bg-[#0E1C2A] border border-line rounded-lg shadow-2xl">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line-soft">
            <div className="text-[11px] text-ink-mute">
              {resolved} of {items.length} resolved · runs server-side
            </div>
            <button
              onClick={() => {
                router.refresh()
                onDismiss()
              }}
              className="text-[11px] text-ink-mute hover:text-ink"
            >
              dismiss
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-line-soft/40">
            {states.map(({ item, state }) => (
              <div key={item.period_id} className="flex items-center gap-2.5 px-4 py-2">
                <StateIcon state={state} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-ink truncate">
                    {item.customer_name}
                    {item.doc_number && (
                      <span className="text-ink-mute font-mono text-[10px]">
                        {" "}
                        #{item.doc_number}
                      </span>
                    )}
                  </div>
                  {"detail" in state && state.detail && (
                    <div className="text-[10px] text-ink-mute break-words">{state.detail}</div>
                  )}
                </div>
                <StateLabel state={state} />
              </div>
            ))}
          </div>
          {runError && (
            <div className="px-4 py-2.5 border-t border-line-soft bg-coral/[0.04] text-[11px] text-coral break-words">
              failed to start: {runError}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StateIcon({ state }: { state: RowState }) {
  switch (state.kind) {
    case "queued":
      return (
        <div className="w-6 h-6 rounded-full border border-line bg-bg-elev flex items-center justify-center shrink-0">
          <Clock className="w-3 h-3 text-ink-mute/60" strokeWidth={1.8} />
        </div>
      )
    case "running": {
      const Icon = state.label.startsWith("charging")
        ? CreditCard
        : state.label.startsWith("recording")
          ? Receipt
          : Mail
      return (
        <div className="w-6 h-6 rounded-full border border-cyan/50 bg-cyan/15 animate-pulse flex items-center justify-center shrink-0">
          <Icon className="w-3 h-3 text-cyan" strokeWidth={1.8} />
        </div>
      )
    }
    case "done":
      return (
        <div className="w-6 h-6 rounded-full border border-grass/40 bg-grass/15 flex items-center justify-center shrink-0">
          <Check className="w-3.5 h-3.5 text-grass" strokeWidth={2.5} />
        </div>
      )
    case "warn":
      return (
        <div className="w-6 h-6 rounded-full border border-sun/40 bg-sun/15 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-3 h-3 text-sun" strokeWidth={2} />
        </div>
      )
    case "failed":
      return (
        <div className="w-6 h-6 rounded-full border border-coral/50 bg-coral/15 flex items-center justify-center shrink-0">
          <X className="w-3.5 h-3.5 text-coral" strokeWidth={2.5} />
        </div>
      )
  }
}

function StateLabel({ state }: { state: RowState }) {
  const tone =
    state.kind === "done"
      ? "text-grass"
      : state.kind === "running"
        ? "text-cyan"
        : state.kind === "warn"
          ? "text-sun"
          : state.kind === "failed"
            ? "text-coral"
            : "text-ink-mute/60"
  const label = state.kind === "queued" ? "queued" : state.label
  return <span className={`text-[10px] shrink-0 ${tone}`}>{label}</span>
}
