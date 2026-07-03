"use client"

import { useEffect, useRef, useState } from "react"
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
 * Live batch progress modal for maintenance processing runs (the WO
 * ProgressModal's sibling, one row per invoice instead of one stage list).
 *
 * Each selected invoice marches through its attempt row's states — queued ->
 * charging -> recording payment -> sending emails -> done/declined/failed —
 * fed by Realtime on billing.processing_attempts plus a 1.5s polling
 * fallback over the billing_processing_attempts view (stage='maint').
 * Invoices that never get an attempt (already emailed -> straight to
 * processed) resolve when the engine's synchronous response lands, which is
 * also the authoritative final word for every row.
 */

export interface RunItem {
  period_id: string
  doc_number: string | null
  customer_name: string
}

export interface RunResult {
  period: string
  customer?: string
  status: string
  error?: string | null
  charged?: number
  receipt_sent?: boolean
  invoice_sent?: boolean | string
  processed?: boolean
  plan?: string
}

interface AttemptRow {
  invoice_number: string | null
  status: string | null
  charge_id: string | null
  qbo_payment_id: string | null
  email_sent: boolean | null
  error_message: string | null
  attempted_at: string
}

type RowState =
  | { kind: "queued" }
  | { kind: "running"; label: string }
  | { kind: "done"; label: string; detail?: string }
  | { kind: "warn"; label: string; detail?: string }
  | { kind: "failed"; label: string; detail?: string }

function stateFromAttempt(a: AttemptRow): RowState {
  switch (a.status) {
    case "pending":
      return { kind: "running", label: "charging…" }
    case "charge_succeeded":
      return a.qbo_payment_id
        ? { kind: "running", label: "sending emails…" }
        : { kind: "running", label: "recording payment…" }
    case "succeeded":
      return { kind: "done", label: "succeeded" }
    case "charge_declined":
      return { kind: "warn", label: "declined", detail: a.error_message ?? undefined }
    case "email_failed":
      return { kind: "warn", label: "email failed", detail: a.error_message ?? undefined }
    case "charge_uncertain":
      return { kind: "failed", label: "charge uncertain — halted", detail: a.error_message ?? undefined }
    case "payment_orphan":
      return { kind: "failed", label: "payment orphan — needs recovery", detail: a.error_message ?? undefined }
    case "error":
      return { kind: "failed", label: "error", detail: a.error_message ?? undefined }
    default:
      return { kind: "queued" }
  }
}

function stateFromResult(r: RunResult): RowState {
  const money = r.charged != null ? `$${r.charged.toFixed(2)} charged` : undefined
  switch (r.status) {
    case "succeeded":
      return {
        kind: "done",
        label: "succeeded",
        detail: [money, r.receipt_sent ? "receipt sent" : null,
                 r.invoice_sent === "already" ? "invoice already emailed" :
                 r.invoice_sent ? "invoice sent" : null]
          .filter(Boolean).join(" · ") || undefined,
      }
    case "invoice_sent":
      return { kind: "done", label: "invoice emailed → processed" }
    case "processed":
      return { kind: "done", label: "already emailed → processed" }
    case "already_paid":
      return { kind: "done", label: "already paid" }
    case "charge_declined":
      return {
        kind: "warn",
        label: r.processed ? "declined → invoiced → processed" : "declined",
        detail: r.error ?? undefined,
      }
    case "email_failed":
      return { kind: "warn", label: "email failed", detail: r.error ?? undefined }
    case "charge_uncertain":
      return { kind: "failed", label: "charge uncertain — halted", detail: r.error ?? undefined }
    case "payment_orphan":
      return { kind: "failed", label: "payment orphan — needs recovery", detail: r.error ?? undefined }
    case "skipped":
      return { kind: "warn", label: "skipped", detail: r.error ?? undefined }
    default:
      return { kind: "failed", label: r.status, detail: r.error ?? undefined }
  }
}

export function MaintProgressModal({
  open,
  onClose,
  items,
  results,
  runError,
  running,
}: {
  open: boolean
  onClose: () => void
  items: RunItem[]
  /** Engine response results — the authoritative final state (null while running). */
  results: RunResult[] | null
  runError: string | null
  running: boolean
}) {
  const router = useRouter()
  const [attempts, setAttempts] = useState<Map<string, AttemptRow>>(new Map())
  const startedAtRef = useRef<string>(new Date().toISOString())

  useEffect(() => {
    if (open) {
      setAttempts(new Map())
      startedAtRef.current = new Date().toISOString()
    }
  }, [open])

  useEffect(() => {
    if (!open || !running) return
    const sb = createSupabaseBrowser()
    const docs = items.map((i) => i.doc_number).filter(Boolean) as string[]
    if (docs.length === 0) return
    let cancelled = false

    const apply = (rows: AttemptRow[]) => {
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
      const { data } = await sb
        .from("billing_processing_attempts")
        .select("invoice_number, status, charge_id, qbo_payment_id, email_sent, error_message, attempted_at")
        .in("invoice_number", docs)
        .eq("stage", "maint")
        .eq("dry_run", false)
        .gte("attempted_at", startedAtRef.current)
      if (data) apply(data as AttemptRow[])
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
          apply([row as unknown as AttemptRow])
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

  const resultByPeriod = new Map((results ?? []).map((r) => [r.period, r]))
  const rowState = (item: RunItem): RowState => {
    const final = resultByPeriod.get(item.period_id)
    if (final) return stateFromResult(final)
    const attempt = item.doc_number ? attempts.get(item.doc_number) : undefined
    if (attempt) return stateFromAttempt(attempt)
    return running ? { kind: "queued" } : { kind: "warn", label: "no result" }
  }

  const canClose = !running

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
      <div className="bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-xl w-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <div className="text-sm font-medium text-ink">
            Processing {items.length} invoice{items.length === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <>
                <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
                <span className="text-[11px] text-cyan">live</span>
              </>
            ) : runError ? (
              <>
                <AlertTriangle className="w-4 h-4 text-coral" strokeWidth={2} />
                <span className="text-[11px] text-coral">failed</span>
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
          {items.map((item) => {
            const st = rowState(item)
            return (
              <div key={item.period_id} className="flex items-center gap-3 py-2.5">
                <StateIcon state={st} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink truncate">
                    {item.customer_name}
                    {item.doc_number && (
                      <span className="text-ink-mute font-mono text-[11px]"> #{item.doc_number}</span>
                    )}
                  </div>
                  {"detail" in st && st.detail && (
                    <div className="text-[11px] text-ink-mute break-words">{st.detail}</div>
                  )}
                </div>
                <StateLabel state={st} />
              </div>
            )
          })}
        </div>

        {runError && (
          <div className="px-5 py-3 border-t border-line-soft bg-coral/[0.04]">
            <div className="text-[11px] uppercase tracking-[0.08em] text-coral/80 mb-1">
              run failed
            </div>
            <div className="text-[12px] text-ink-dim break-words">{runError}</div>
          </div>
        )}

        <div className="px-5 py-4 border-t border-line-soft flex justify-end">
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
            {canClose ? "Close" : "Running…"}
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
