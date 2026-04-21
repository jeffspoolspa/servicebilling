"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  X,
  Loader2,
  AlertTriangle,
  Clock,
  CreditCard,
  Mail,
  ChevronRight,
} from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Live batch-processing progress modal.
 *
 * Mirrors ProgressModal's single-invoice semantics but for the N-invoice
 * "Process Selected" case. Each invoice gets its own row with a status icon,
 * customer + doc number, and balance. Currently-processing rows get a subtle
 * cyan shimmer; completed rows compact down with a check; failed rows stay
 * expanded with an error line.
 *
 * DATA FLOW (same architecture as ProgressModal):
 *
 *   Script (process_invoice) → Postgres (billing.processing_attempts)
 *                            → Realtime broadcasts UPDATE/INSERT
 *                            → Modal seeds + subscribes + 1.5s poll fallback
 *                            → Per-invoice reducer flips UI state
 *
 * The modal is a pure observer — it never talks to the script or the API
 * directly. Firing the batch is the caller's job (QueueActions); the modal
 * just watches the DB transitions. This keeps it equally useful for in-flight
 * runs triggered by cron or other UI actions.
 *
 * ANIMATION NOTES (Emil Kowalski's "Animations on the Web"):
 * - Enter/exit (modal surface): ease-out, 200ms
 * - Active-row shimmer: ease-in-out, continuous — on-screen motion, not enter
 * - Status icon swap: scale 0.85→1 ease-out, 180ms
 * - Completed-row pop: quick scale bump, 280ms ease-out
 * - `prefers-reduced-motion`: disables shimmer and pops; state swaps remain
 * - Transform + opacity only (GPU); no layout-triggering props animated
 */

export interface BatchInvoiceSummary {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  balance: number
  payment_method: "on_file" | "invoice" | string | null
  wo_number?: string | null
}

type RowStatus = "queued" | "active" | "done" | "failed" | "uncertain"

interface AttemptSnapshot {
  status: string
  charge_id: string | null
  qbo_payment_id: string | null
  email_sent: boolean | null
  error_message: string | null
  attempted_at: string
  dry_run: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  invoices: BatchInvoiceSummary[]
  dryRun: boolean
  /** ms timestamp of when the batch was fired — used to distinguish "new batch"
   *  from a stale attempt row left over from a previous run. */
  triggeredAt: number | null
}

export function BatchProgressModal({
  open,
  onClose,
  invoices,
  dryRun,
  triggeredAt,
}: Props) {
  const router = useRouter()
  const [snapshots, setSnapshots] = useState<Map<string, AttemptSnapshot>>(
    new Map(),
  )
  // Track rows that just transitioned into `done` so we can play the one-shot
  // "pop" animation without re-triggering on every re-render.
  const [justDone, setJustDone] = useState<Set<string>>(new Set())
  const doneSeenRef = useRef<Set<string>>(new Set())
  const channelRef = useRef<ReturnType<
    ReturnType<typeof createSupabaseBrowser>["channel"]
  > | null>(null)

  // Reset on each new batch trigger
  useEffect(() => {
    if (open) {
      setSnapshots(new Map())
      setJustDone(new Set())
      doneSeenRef.current = new Set()
    }
  }, [open, triggeredAt])

  // Seed + subscribe + poll while modal is open
  useEffect(() => {
    if (!open || invoices.length === 0) return
    const sb = createSupabaseBrowser()
    const invoiceIds = invoices.map((i) => i.qbo_invoice_id)
    let cancelled = false

    async function refresh() {
      if (cancelled) return
      const { data } = await sb
        .from("billing_processing_attempts")
        .select(
          "qbo_invoice_id, status, charge_id, qbo_payment_id, email_sent, error_message, attempted_at, dry_run, stage",
        )
        .in("qbo_invoice_id", invoiceIds)
        .eq("stage", "process")
        .eq("dry_run", dryRun)
        .order("attempted_at", { ascending: false })
      if (cancelled || !data) return

      // Take only the most recent attempt per invoice (query is desc-ordered)
      const byId = new Map<string, AttemptSnapshot>()
      for (const row of data as (AttemptSnapshot & { qbo_invoice_id: string })[]) {
        if (!byId.has(row.qbo_invoice_id)) {
          byId.set(row.qbo_invoice_id, row)
        }
      }
      setSnapshots(byId)

      // Mark newly-succeeded rows so they get the pop animation
      const newlyDone = new Set<string>()
      byId.forEach((snap, id) => {
        if (snap.status === "succeeded" && !doneSeenRef.current.has(id)) {
          doneSeenRef.current.add(id)
          newlyDone.add(id)
        }
      })
      if (newlyDone.size > 0) {
        setJustDone((prev) => new Set([...prev, ...newlyDone]))
        // Clear the "just done" flag after the animation completes
        setTimeout(() => {
          setJustDone((prev) => {
            const next = new Set(prev)
            newlyDone.forEach((id) => next.delete(id))
            return next
          })
        }, 400)
      }
    }

    refresh()
    const pollInterval = setInterval(refresh, 1500)

    // Realtime nice-to-have — polling guarantees correctness
    const channel = sb
      .channel(`batch-progress-${triggeredAt ?? Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "billing",
          table: "processing_attempts",
        },
        (payload) => {
          const row = (payload as unknown as { new?: Record<string, unknown> }).new
          if (!row) return
          const qid = row.qbo_invoice_id as string
          if (!invoiceIds.includes(qid)) return
          if (row.stage !== "process") return
          if (row.dry_run !== dryRun) return
          refresh()
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
  }, [open, triggeredAt, dryRun])

  // Derive per-row status from its attempt snapshot
  const rowStatus = useMemo(() => {
    const m = new Map<string, RowStatus>()
    for (const inv of invoices) {
      const snap = snapshots.get(inv.qbo_invoice_id)
      if (!snap) {
        m.set(inv.qbo_invoice_id, "queued")
        continue
      }
      switch (snap.status) {
        case "succeeded":
          m.set(inv.qbo_invoice_id, "done")
          break
        case "charge_declined":
        case "payment_orphan":
        case "email_failed":
        case "error":
          m.set(inv.qbo_invoice_id, "failed")
          break
        case "charge_uncertain":
          m.set(inv.qbo_invoice_id, "uncertain")
          break
        case "pending":
        case "charge_succeeded":
        default:
          m.set(inv.qbo_invoice_id, "active")
      }
    }
    return m
  }, [invoices, snapshots])

  const counts = useMemo(() => {
    const c = { queued: 0, active: 0, done: 0, failed: 0, uncertain: 0 }
    rowStatus.forEach((s) => {
      c[s]++
    })
    return c
  }, [rowStatus])

  const total = invoices.length
  const completed = counts.done + counts.failed + counts.uncertain
  const progressPct = total > 0 ? (completed / total) * 100 : 0
  const allDone = completed === total
  const totalAmount = invoices.reduce((a, i) => a + (i.balance || 0), 0)
  const canClose = allDone || !open

  if (!open) return null

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
      <div className="modal-surface-enter bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-line-soft flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-medium text-ink">
              {dryRun ? "Dry-running" : "Processing"} {total} invoice{total === 1 ? "" : "s"}
              {dryRun && (
                <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-cyan bg-cyan/10 border border-cyan/30 rounded px-1.5 py-0.5">
                  dry run
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-mute mt-0.5 tabular-nums">
              {completed} of {total} · {formatCurrency(totalAmount)} total
              {counts.failed > 0 && (
                <span className="text-coral ml-2">· {counts.failed} failed</span>
              )}
              {counts.uncertain > 0 && (
                <span className="text-sun ml-2">· {counts.uncertain} uncertain</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {allDone ? (
              counts.failed === 0 && counts.uncertain === 0 ? (
                <>
                  <Check className="w-4 h-4 text-grass" strokeWidth={2.5} />
                  <span className="text-[11px] text-grass">all done</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-coral" strokeWidth={2} />
                  <span className="text-[11px] text-coral">done with issues</span>
                </>
              )
            ) : (
              <>
                <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
                <span className="text-[11px] text-cyan">live</span>
              </>
            )}
          </div>
        </div>

        {/* Overall progress bar — ease-in-out because it's on-screen motion */}
        <div className="h-1 bg-line-soft overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan to-teal transition-[width] duration-300"
            style={{
              width: `${progressPct}%`,
              transitionTimingFunction: "cubic-bezier(0.645, 0.045, 0.355, 1)",
            }}
          />
        </div>

        {/* Row list */}
        <div className="overflow-y-auto flex-1 p-3 space-y-1.5">
          {invoices.map((inv) => {
            const st = rowStatus.get(inv.qbo_invoice_id) ?? "queued"
            const snap = snapshots.get(inv.qbo_invoice_id)
            return (
              <Row
                key={inv.qbo_invoice_id}
                invoice={inv}
                status={st}
                snapshot={snap ?? null}
                justPopped={justDone.has(inv.qbo_invoice_id)}
              />
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line-soft flex justify-between items-center">
          <div className="text-[11px] text-ink-mute">
            {allDone ? (
              <span>Click any row to open its work order.</span>
            ) : (
              <span>Keep this open — closes automatically when done.</span>
            )}
          </div>
          <Button
            size="sm"
            variant={canClose ? "default" : "ghost"}
            disabled={!canClose}
            onClick={() => {
              router.refresh()
              onClose()
            }}
          >
            {canClose ? "Close" : "Running..."}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Row
// ───────────────────────────────────────────────────────────────────────────

function Row({
  invoice,
  status,
  snapshot,
  justPopped,
}: {
  invoice: BatchInvoiceSummary
  status: RowStatus
  snapshot: AttemptSnapshot | null
  justPopped: boolean
}) {
  // Compose class names by status — only transform + opacity + bg change,
  // so GPU-accelerated. Layout stays stable row-to-row to keep motion calm.
  const base =
    "relative rounded-lg border px-3 py-2.5 transition-colors duration-200 ease-out flex items-center gap-3"
  const styles: Record<RowStatus, string> = {
    queued: "border-line-soft bg-bg-elev/40 opacity-70",
    active: "border-cyan/40 bg-cyan/[0.04] batch-active-shimmer",
    done: "border-grass/30 bg-grass/[0.04]",
    failed: "border-coral/40 bg-coral/[0.06]",
    uncertain: "border-sun/40 bg-sun/[0.06]",
  }

  const popClass = justPopped ? "row-complete-pop" : ""

  const methodHint = invoice.payment_method === "on_file" ? "Charge card" : "Send email"

  return (
    <div className={`${base} ${styles[status]} ${popClass}`}>
      <StatusIcon status={status} paymentMethod={invoice.payment_method} />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-ink truncate">
            {invoice.customer_name ?? "—"}
          </span>
          <span className="text-[11px] text-ink-mute font-mono">
            {invoice.doc_number ?? invoice.qbo_invoice_id}
          </span>
          {invoice.wo_number && (
            <span className="text-[11px] text-ink-mute">· WO {invoice.wo_number}</span>
          )}
        </div>
        <div className="text-[11px] text-ink-mute mt-0.5 flex items-center gap-1.5 truncate">
          <StatusText status={status} snapshot={snapshot} paymentMethod={invoice.payment_method} />
          {status === "queued" && <span>· {methodHint}</span>}
        </div>
      </div>

      <div className="flex-shrink-0 text-right">
        {status === "done" ? (
          <span className="text-[12px] text-grass num">
            {invoice.payment_method === "on_file" ? "charged" : "sent"}
          </span>
        ) : (
          <span className="text-[12px] text-ink-dim num">
            {formatCurrency(invoice.balance)}
          </span>
        )}
      </div>
    </div>
  )
}

function StatusIcon({
  status,
  paymentMethod,
}: {
  status: RowStatus
  paymentMethod: string | null
}) {
  // Wrapper lets us play the swap-in animation when the icon identity changes.
  // Keyed by status so React recreates the element on transition.
  const inner = () => {
    switch (status) {
      case "done":
        return <Check className="w-3.5 h-3.5 text-grass" strokeWidth={3} />
      case "failed":
        return <X className="w-3.5 h-3.5 text-coral" strokeWidth={3} />
      case "uncertain":
        return <AlertTriangle className="w-3.5 h-3.5 text-sun" strokeWidth={2.5} />
      case "active":
        return <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" strokeWidth={2} />
      case "queued":
      default:
        return paymentMethod === "on_file" ? (
          <CreditCard className="w-3.5 h-3.5 text-ink-mute" strokeWidth={1.8} />
        ) : paymentMethod === "invoice" ? (
          <Mail className="w-3.5 h-3.5 text-ink-mute" strokeWidth={1.8} />
        ) : (
          <Clock className="w-3.5 h-3.5 text-ink-mute" strokeWidth={1.8} />
        )
    }
  }

  const bg: Record<RowStatus, string> = {
    queued: "bg-bg-elev border border-line",
    active: "bg-cyan/15 border border-cyan/40",
    done: "bg-grass/15 border border-grass/40",
    failed: "bg-coral/15 border border-coral/40",
    uncertain: "bg-sun/15 border border-sun/40",
  }

  return (
    <div
      key={status} // re-mount on transition → plays icon-swap-in animation
      className={`w-7 h-7 rounded-full grid place-items-center flex-shrink-0 icon-swap-in ${bg[status]}`}
    >
      {inner()}
    </div>
  )
}

function StatusText({
  status,
  snapshot,
  paymentMethod,
}: {
  status: RowStatus
  snapshot: AttemptSnapshot | null
  paymentMethod: string | null
}) {
  if (status === "queued") return <span>Queued</span>
  if (status === "active") {
    if (snapshot?.status === "charge_succeeded") {
      return <span>Charge landed, recording payment...</span>
    }
    return (
      <span>
        {paymentMethod === "on_file" ? "Charging card..." : "Sending email..."}
      </span>
    )
  }
  if (status === "done") {
    return (
      <span className="text-grass/80 flex items-center gap-1">
        Completed
        {snapshot?.charge_id && (
          <>
            <ChevronRight className="w-3 h-3" />
            <span className="font-mono">{snapshot.charge_id.slice(0, 10)}…</span>
          </>
        )}
      </span>
    )
  }
  if (status === "uncertain") {
    return <span className="text-sun">Uncertain — reconciliation will resolve</span>
  }
  if (status === "failed") {
    const reason =
      snapshot?.status === "payment_orphan"
        ? "Payment orphan — charge ok, ledger write failed"
        : snapshot?.status === "charge_declined"
          ? "Card declined"
          : snapshot?.status === "email_failed"
            ? "Email failed"
            : snapshot?.error_message?.slice(0, 80) ?? "Failed"
    return <span className="text-coral">{reason}</span>
  }
  return null
}
