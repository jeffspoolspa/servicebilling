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
import { Button } from "@/components/ui/button"

/**
 * Live batch progress modal for maintenance processing runs — the WO
 * fire-and-forget pattern: the route returns a jobId immediately and this
 * modal tracks the DB rows the engine writes as it works.
 *
 * Two feeds, both polled (1.5s) with Realtime riding on top for instant
 * attempt updates:
 *   - billing_processing_attempts view (stage='maint', this run's window):
 *     per-invoice stage detail — charging -> recording payment -> emails ->
 *     succeeded/declined/halted.
 *   - maint_billing_period_statuses RPC: the periods' processing_status +
 *     balance — the authoritative "is this row finished" signal. It also
 *     resolves rows that never create an attempt (already emailed ->
 *     straight to processed).
 *
 * A row is resolved when its period reads processed OR its attempt reaches a
 * halt state (declined without email, uncertain, orphan). The run is done
 * when every row is resolved. Closing never aborts anything — the engine
 * runs server-side regardless — so Close is always available.
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
        return {
          kind: "done",
          label: "succeeded",
          detail: amt ? `${amt} charged` : undefined,
        }
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
    // no attempt this run — the already-emailed -> processed path (or paid)
    return { kind: "done", label: paid ? "processed · paid" : "processed · invoice out" }
  }
  return running ? { kind: "queued" } : { kind: "warn", label: "not processed" }
}

function isResolved(st: RowState): boolean {
  return st.kind === "done" || st.kind === "failed" || (st.kind === "warn" && true)
}

export function MaintProgressModal({
  open,
  onClose,
  items,
  runError,
  fired,
}: {
  open: boolean
  onClose: () => void
  items: RunItem[]
  /** Trigger call failed — nothing is running. */
  runError: string | null
  /** True once the Windmill job was accepted (jobId returned). */
  fired: boolean
}) {
  const router = useRouter()
  const [attempts, setAttempts] = useState<Map<string, AttemptRow>>(new Map())
  const [periods, setPeriods] = useState<Map<string, PeriodStatus>>(new Map())
  const startedAtRef = useRef<string>(new Date().toISOString())

  useEffect(() => {
    if (open) {
      setAttempts(new Map())
      setPeriods(new Map())
      startedAtRef.current = new Date().toISOString()
    }
  }, [open])

  // resolved-state computation must precede the polling effect's deps
  const states = useMemo(() => {
    const running = fired && !runError
    return items.map((item) => {
      const attempt = item.doc_number ? attempts.get(item.doc_number) : undefined
      const period = periods.get(item.period_id)
      return { item, state: deriveState(attempt, period, running) }
    })
  }, [items, attempts, periods, fired, runError])

  const allResolved = states.length > 0 && states.every(({ state }) => isResolved(state))
  const running = fired && !runError && !allResolved

  useEffect(() => {
    if (!open || !running) return
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
              .select("invoice_number, status, charge_amount, qbo_payment_id, error_message, attempted_at")
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
  }, [open, running])

  if (!open) return null

  const doneCount = states.filter(({ state }) => isResolved(state)).length

  return (
    <div
      className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          router.refresh()
          onClose()
        }
      }}
    >
      <div className="bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-xl w-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <div>
            <div className="text-sm font-medium text-ink">
              Processing {items.length} invoice{items.length === 1 ? "" : "s"}
            </div>
            <div className="text-[11px] text-ink-mute mt-0.5">
              {doneCount} of {items.length} resolved · runs server-side — closing does not stop it
            </div>
          </div>
          <div className="flex items-center gap-2">
            {runError ? (
              <>
                <AlertTriangle className="w-4 h-4 text-coral" strokeWidth={2} />
                <span className="text-[11px] text-coral">failed to start</span>
              </>
            ) : running ? (
              <>
                <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
                <span className="text-[11px] text-cyan">live</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4 text-grass" strokeWidth={2.5} />
                <span className="text-[11px] text-grass">done</span>
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-3 max-h-[55vh] overflow-y-auto divide-y divide-line-soft/50">
          {states.map(({ item, state }) => (
            <div key={item.period_id} className="flex items-center gap-3 py-2.5">
              <StateIcon state={state} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink truncate">
                  {item.customer_name}
                  {item.doc_number && (
                    <span className="text-ink-mute font-mono text-[11px]">
                      {" "}
                      #{item.doc_number}
                    </span>
                  )}
                </div>
                {"detail" in state && state.detail && (
                  <div className="text-[11px] text-ink-mute break-words">{state.detail}</div>
                )}
              </div>
              <StateLabel state={state} />
            </div>
          ))}
        </div>

        {runError && (
          <div className="px-5 py-3 border-t border-line-soft bg-coral/[0.04]">
            <div className="text-[11px] uppercase tracking-[0.08em] text-coral/80 mb-1">
              run failed to start
            </div>
            <div className="text-[12px] text-ink-dim break-words">{runError}</div>
          </div>
        )}

        <div className="px-5 py-4 border-t border-line-soft flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              router.refresh()
              onClose()
            }}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}

function StateIcon({ state }: { state: RowState }) {
  switch (state.kind) {
    case "queued":
      return (
        <div className="w-7 h-7 rounded-full border border-line bg-bg-elev flex items-center justify-center">
          <Clock className="w-3.5 h-3.5 text-ink-mute/60" strokeWidth={1.8} />
        </div>
      )
    case "running": {
      const Icon = state.label.startsWith("charging")
        ? CreditCard
        : state.label.startsWith("recording")
          ? Receipt
          : Mail
      return (
        <div className="w-7 h-7 rounded-full border border-cyan/50 bg-cyan/15 ring-2 ring-cyan/30 animate-pulse flex items-center justify-center">
          <Icon className="w-3.5 h-3.5 text-cyan" strokeWidth={1.8} />
        </div>
      )
    }
    case "done":
      return (
        <div className="w-7 h-7 rounded-full border border-grass/40 bg-grass/15 flex items-center justify-center">
          <Check className="w-4 h-4 text-grass" strokeWidth={2.5} />
        </div>
      )
    case "warn":
      return (
        <div className="w-7 h-7 rounded-full border border-sun/40 bg-sun/15 flex items-center justify-center">
          <AlertTriangle className="w-3.5 h-3.5 text-sun" strokeWidth={2} />
        </div>
      )
    case "failed":
      return (
        <div className="w-7 h-7 rounded-full border border-coral/50 bg-coral/15 flex items-center justify-center">
          <X className="w-4 h-4 text-coral" strokeWidth={2.5} />
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
  return <span className={`text-[11px] shrink-0 ${tone}`}>{label}</span>
}
