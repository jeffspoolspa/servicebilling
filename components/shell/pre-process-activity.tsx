"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import {
  Loader2,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { cn } from "@/lib/utils/cn"

/**
 * Global pre-processing activity toast.
 *
 * Lives in the shell layout so it's visible on every page. Subscribes to
 * billing.invoices via Supabase Realtime and watches the pre_process_stage
 * column. The script writes that column at every step ('fetching_qbo' →
 * 'checking_subtotal' → … → 'done'), so any pre-processing run anywhere
 * — single re-run, multi-select bulk, sync-from-QBO triggering 50 jobs,
 * the DB trigger when a new WO links — surfaces here automatically.
 *
 * The user doesn't need to refresh or stay on a particular page; if pre-
 * processing is happening, they see it.
 *
 * Layout: bottom-right pinned card. Collapsed shows count + spinner.
 * Click to expand: list of in-flight invoices + last 5 completed.
 * Auto-fades 8s after the queue drains.
 */

type Stage =
  | "fetching_qbo"
  | "checking_subtotal"
  | "matching_credits"
  | "resolving_payment_method"
  | "deriving_class"
  | "generating_memo"
  | "writing_qbo"
  | "done"
  | (string & {})

const STAGE_LABEL: Record<string, string> = {
  fetching_qbo: "Fetching from QBO",
  checking_subtotal: "Checking subtotal",
  matching_credits: "Matching credits",
  resolving_payment_method: "Resolving payment method",
  deriving_class: "Deriving QBO class",
  generating_memo: "Generating memo",
  writing_qbo: "Writing back to QBO",
}

interface InFlight {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  stage: Stage
  started_at: number   // ms epoch — when we first saw it as non-done
  last_seen_at: number // ms — for stale detection
}

interface Recent {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  outcome: "ready" | "review" | "error"
  needs_review_reason: string | null
  finished_at: number
}

// If we don't see any stage update for an invoice in this many ms, treat it
// as stuck (script crashed mid-flight) and drop from in-flight. Keeps
// phantom rows from sticking forever.
const STALE_MS = 90_000

// Linger time after the queue empties before we hide the toast.
const LINGER_MS = 8_000

// How many recent completions to keep visible in the expanded view.
const RECENT_LIMIT = 6

export function PreProcessActivity() {
  const [inFlight, setInFlight] = useState<Map<string, InFlight>>(new Map())
  const [recent, setRecent] = useState<Recent[]>([])
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // Visibility hysteresis — when in-flight drains, linger so the user can
  // see the final summary; reset on any new activity.
  const [lingerUntil, setLingerUntil] = useState<number | null>(null)
  const [, forceTick] = useState(0)
  // Track which invoice IDs we've actually seen as in-flight in this
  // session. Critical because billing.invoices.pre_process_stage stays at
  // 'done' permanently after the original pre-processing finishes — and
  // ANY subsequent UPDATE on the row (charge, payment recorded, balance
  // change from refresh_invoice, etc.) fires Realtime with stage='done'.
  // Without this guard, every process_invoice run would falsely surface
  // those invoices as "Pre-processing complete" in the toast. Only show
  // 'done' transitions for IDs we previously saw at a non-done stage.
  const seenInFlightRef = useRef<Set<string>>(new Set())

  // One periodic tick that does double duty: forces a re-render so the
  // "elapsed Ns" counters tick, AND evicts stale in-flight rows where
  // the last stage update is older than STALE_MS (script likely crashed
  // — without this the toast would show ghosts forever).
  useEffect(() => {
    const id = setInterval(() => {
      forceTick((t) => t + 1)
      const cutoff = Date.now() - STALE_MS
      setInFlight((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, row] of prev) {
          if (row.last_seen_at < cutoff) {
            next.delete(id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Seed: query rows currently mid-flight. Anything where pre_process_stage
  // isn't null/done — and has a recent enough fetched_at — is something we
  // want to track.
  useEffect(() => {
    let cancelled = false
    const sb = createSupabaseBrowser()
    sb.from("billing_invoices")
      .select("qbo_invoice_id, doc_number, customer_name, pre_process_stage, fetched_at")
      .not("pre_process_stage", "in", '("done")')
      .not("pre_process_stage", "is", null)
      .order("fetched_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (cancelled || !data) return
        const cutoff = Date.now() - STALE_MS
        const next = new Map<string, InFlight>()
        for (const r of data as Array<Record<string, unknown>>) {
          const fetchedAt = r.fetched_at ? new Date(String(r.fetched_at)).getTime() : 0
          if (fetchedAt < cutoff) continue
          const id = String(r.qbo_invoice_id)
          // Mark as seen so a later 'done' transition fires the recent toast.
          seenInFlightRef.current.add(id)
          next.set(id, {
            qbo_invoice_id: id,
            doc_number: (r.doc_number as string | null) ?? null,
            customer_name: (r.customer_name as string | null) ?? null,
            stage: String(r.pre_process_stage ?? "fetching_qbo") as Stage,
            started_at: Date.now(),
            last_seen_at: Date.now(),
          })
        }
        setInFlight(next)
        if (next.size > 0) {
          setDismissed(false)
          setLingerUntil(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Realtime subscription — single channel for the whole app session.
  // Filter on UPDATEs to billing.invoices; we look at pre_process_stage
  // transitions client-side. (Postgres Realtime can't filter on a
  // string-not-equals so we accept all UPDATEs and gate locally.)
  useEffect(() => {
    const sb = createSupabaseBrowser()
    const channel = sb
      .channel("preprocess-activity-global")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "billing", table: "invoices" },
        (payload) => {
          const row = (payload as { new?: Record<string, unknown> }).new
          if (!row) return
          const id = String(row.qbo_invoice_id)
          const stage = (row.pre_process_stage ?? null) as string | null
          const billingStatus = (row.billing_status as string | null) ?? null
          const needsReason = (row.needs_review_reason as string | null) ?? null
          const docNumber = (row.doc_number as string | null) ?? null
          const customerName = (row.customer_name as string | null) ?? null

          if (stage && stage !== "done") {
            // Real pre-processing in flight — track it.
            seenInFlightRef.current.add(id)
            setInFlight((prev) => {
              const next = new Map(prev)
              const existing = next.get(id)
              next.set(id, {
                qbo_invoice_id: id,
                doc_number: docNumber,
                customer_name: customerName,
                stage,
                started_at: existing?.started_at ?? Date.now(),
                last_seen_at: Date.now(),
              })
              return next
            })
            setDismissed(false)
            setLingerUntil(null)
            return
          }

          if (stage === "done") {
            // CRITICAL guard: pre_process_stage='done' is the PERMANENT
            // terminal value left over from the original pre-processing
            // (which may have happened weeks ago). ANY UPDATE on the row
            // — charge processed, payment recorded, balance refreshed,
            // memo edited, anything — fires Realtime with stage='done'.
            // Without this guard, every process_invoice run would falsely
            // surface the invoice as a "Pre-processing complete" event.
            // Only fire the completion toast for IDs we actually saw at
            // a non-done stage in this session.
            if (!seenInFlightRef.current.has(id)) return
            seenInFlightRef.current.delete(id)

            // Compute outcome from billing_status + needs_review_reason.
            let outcome: Recent["outcome"] = "ready"
            if (billingStatus === "needs_review") outcome = "review"
            else if (billingStatus === "ready_to_process") outcome = "ready"
            else if (billingStatus === "processed") outcome = "ready"
            else outcome = "error"

            setInFlight((prev) => {
              if (!prev.has(id)) return prev
              const next = new Map(prev)
              next.delete(id)
              return next
            })
            setRecent((prev) => {
              const completion: Recent = {
                qbo_invoice_id: id,
                doc_number: docNumber,
                customer_name: customerName,
                outcome,
                needs_review_reason: needsReason,
                finished_at: Date.now(),
              }
              const filtered = prev.filter((r) => r.qbo_invoice_id !== id)
              return [completion, ...filtered].slice(0, RECENT_LIMIT)
            })
          }
        },
      )
      .subscribe()

    return () => {
      sb.removeChannel(channel)
    }
  }, [])

  // Linger logic: when in-flight drains to 0, schedule auto-hide.
  useEffect(() => {
    if (inFlight.size > 0) {
      setLingerUntil(null)
      return
    }
    if (recent.length === 0) return
    setLingerUntil(Date.now() + LINGER_MS)
  }, [inFlight.size, recent.length])

  const visible =
    !dismissed &&
    (inFlight.size > 0 ||
      (lingerUntil !== null && Date.now() < lingerUntil))

  // Counters per outcome for the recent run.
  const counts = useMemo(() => {
    let ready = 0, review = 0, error = 0
    for (const r of recent) {
      if (r.outcome === "ready") ready++
      else if (r.outcome === "review") review++
      else error++
    }
    return { ready, review, error }
  }, [recent])

  if (!visible) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 pointer-events-auto">
      <div className="bg-bg-elev border border-line-soft rounded-lg shadow-2xl shadow-black/40 backdrop-blur-md min-w-[280px] max-w-[380px] overflow-hidden">
        {/* Header: count + status + collapse toggle */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-white/[0.03] transition-colors"
        >
          {inFlight.size > 0 ? (
            <>
              <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
              <div className="flex-1 text-left">
                <div className="text-[12px] text-ink font-medium">
                  Pre-processing {inFlight.size} invoice{inFlight.size === 1 ? "" : "s"}
                </div>
                <div className="text-[10px] text-ink-mute font-mono">
                  {recent.length > 0 && (
                    <>
                      {counts.ready > 0 && (
                        <span className="text-grass">{counts.ready} ready</span>
                      )}
                      {counts.review > 0 && (
                        <>
                          {counts.ready > 0 && " · "}
                          <span className="text-sun">{counts.review} review</span>
                        </>
                      )}
                      {counts.error > 0 && (
                        <>
                          {(counts.ready > 0 || counts.review > 0) && " · "}
                          <span className="text-coral">{counts.error} error</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <Check className="w-4 h-4 text-grass" strokeWidth={2.5} />
              <div className="flex-1 text-left">
                <div className="text-[12px] text-ink font-medium">
                  Pre-processing complete
                </div>
                <div className="text-[10px] text-ink-mute font-mono">
                  {counts.ready > 0 && (
                    <span className="text-grass">{counts.ready} ready</span>
                  )}
                  {counts.review > 0 && (
                    <>
                      {counts.ready > 0 && " · "}
                      <span className="text-sun">{counts.review} review</span>
                    </>
                  )}
                  {counts.error > 0 && (
                    <>
                      {(counts.ready > 0 || counts.review > 0) && " · "}
                      <span className="text-coral">{counts.error} error</span>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-ink-mute" strokeWidth={2} />
          ) : (
            <ChevronUp className="w-4 h-4 text-ink-mute" strokeWidth={2} />
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              setDismissed(true)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation()
                setDismissed(true)
              }
            }}
            className="text-ink-mute hover:text-ink p-0.5 rounded -mr-1 cursor-pointer"
            title="Dismiss (will reappear on next pre-process)"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </span>
        </button>

        {/* Expanded body */}
        {expanded && (
          <div className="border-t border-line-soft max-h-[320px] overflow-y-auto">
            {inFlight.size > 0 && (
              <div className="px-3.5 py-2">
                <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute mb-1.5">
                  In flight
                </div>
                <div className="flex flex-col gap-1">
                  {[...inFlight.values()]
                    .sort((a, b) => a.started_at - b.started_at)
                    .map((row) => (
                      <InFlightRow key={row.qbo_invoice_id} row={row} />
                    ))}
                </div>
              </div>
            )}
            {recent.length > 0 && (
              <div className="px-3.5 py-2 border-t border-line-soft">
                <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute mb-1.5">
                  Recent
                </div>
                <div className="flex flex-col gap-1">
                  {recent.map((r) => (
                    <RecentRow key={r.qbo_invoice_id + r.finished_at} row={r} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function InFlightRow({ row }: { row: InFlight }) {
  const elapsed = Math.max(0, Math.floor((Date.now() - row.started_at) / 1000))
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <Loader2 className="w-3 h-3 text-cyan animate-spin shrink-0" strokeWidth={2} />
      <div className="font-mono text-ink-dim shrink-0 w-14 truncate">
        {row.doc_number ?? row.qbo_invoice_id}
      </div>
      <div className="text-ink-mute truncate flex-1">
        {STAGE_LABEL[row.stage] ?? row.stage}
      </div>
      <div className="font-mono text-ink-mute/70 tabular-nums shrink-0">
        {elapsed}s
      </div>
    </div>
  )
}

function RecentRow({ row }: { row: Recent }) {
  const Icon =
    row.outcome === "ready"
      ? Check
      : row.outcome === "review"
        ? AlertTriangle
        : AlertTriangle
  const tone =
    row.outcome === "ready"
      ? "text-grass"
      : row.outcome === "review"
        ? "text-sun"
        : "text-coral"
  return (
    <Link
      href={`/work-orders/${row.qbo_invoice_id}` as never}
      className="flex items-center gap-2 text-[11px] hover:bg-white/[0.03] -mx-1 px-1 py-0.5 rounded transition-colors"
      title={row.needs_review_reason ?? undefined}
    >
      <Icon className={cn("w-3 h-3 shrink-0", tone)} strokeWidth={2.5} />
      <div className="font-mono text-ink-dim shrink-0 w-14 truncate">
        {row.doc_number ?? row.qbo_invoice_id}
      </div>
      <div className="text-ink-mute truncate flex-1">
        {row.customer_name ?? "—"}
      </div>
    </Link>
  )
}
