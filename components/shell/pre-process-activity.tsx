"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Check, AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { cn } from "@/lib/utils/cn"

/**
 * Global pre-processing completion feed.
 *
 * Lives in the shell layout so it's visible on every page. Subscribes to
 * billing.invoices via Supabase Realtime and watches the ONE fact the
 * pipeline stamps when an enrichment run finishes: pre_processed_at. A fresh
 * stamp = a completion; enrichment_ok / billing_status classify the outcome.
 * No stage column, no in-flight tracking — the row's own facts are the
 * progress (mid-flight visibility lives on the queue views/dashboards).
 *
 * Layout: bottom-right pinned card. Collapsed shows counts; click to expand
 * the recent-completion list. Auto-fades after LINGER_MS of quiet.
 */

interface Recent {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  outcome: "ready" | "review" | "error"
  needs_review_reason: string | null
  finished_at: number
}

// A pre_processed_at stamp older than this is history, not a live completion.
const FRESH_MS = 5 * 60_000
// Linger time after the last completion before the toast hides.
const LINGER_MS = 8_000
// How many recent completions to keep visible in the expanded view.
const RECENT_LIMIT = 6

export function PreProcessActivity() {
  const [recent, setRecent] = useState<Recent[]>([])
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [lingerUntil, setLingerUntil] = useState<number | null>(null)
  const [, forceTick] = useState(0)
  // Last pre_processed_at we saw per invoice: only a CHANGED stamp is a
  // completion (any other row update — charge, balance echo, memo edit —
  // carries the same old stamp and must not re-toast).
  const stampRef = useRef<Map<string, string>>(new Map())

  // Tick to refresh the auto-hide window.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const sb = createSupabaseBrowser()

    // Seed the stamp map (so already-processed rows don't toast on their
    // next unrelated update) + surface completions from the last few minutes.
    let cancelled = false
    void sb
      .from("billing_invoices")
      .select(
        "qbo_invoice_id, doc_number, customer_name, pre_processed_at, enrichment_ok, billing_status, needs_review_reason",
      )
      .not("pre_processed_at", "is", null)
      .order("pre_processed_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (cancelled || !data) return
        const now = Date.now()
        const fresh: Recent[] = []
        for (const r of data as unknown as Array<Record<string, unknown>>) {
          const id = String(r.qbo_invoice_id)
          const stamp = String(r.pre_processed_at)
          stampRef.current.set(id, stamp)
          if (now - Date.parse(stamp) < FRESH_MS && fresh.length < RECENT_LIMIT) {
            fresh.push(classify(r, Date.parse(stamp)))
          }
        }
        if (fresh.length > 0) {
          setRecent(fresh)
          setLingerUntil(Date.now() + LINGER_MS)
        }
      })

    const channel = sb
      .channel("preprocess-activity-global")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "billing", table: "invoices" },
        (payload) => {
          const row = (payload as { new?: Record<string, unknown> }).new
          if (!row?.pre_processed_at) return
          const id = String(row.qbo_invoice_id)
          const stamp = String(row.pre_processed_at)
          if (stampRef.current.get(id) === stamp) return // not a completion
          stampRef.current.set(id, stamp)
          if (Date.now() - Date.parse(stamp) > FRESH_MS) return

          // Fresh SELECT before classifying: the projection trigger's
          // self-UPDATE writes billing_status AFTER this event's snapshot,
          // so the payload's status can be stale. Both commit in one
          // transaction — a read here sees the final state.
          void (async () => {
            const { data } = await sb
              .from("billing_invoices")
              .select("doc_number, customer_name, enrichment_ok, billing_status, needs_review_reason")
              .eq("qbo_invoice_id", id)
              .single()
            setRecent((prev) => {
              const completion = classify({ ...row, ...(data ?? {}) }, Date.now())
              const filtered = prev.filter((r) => r.qbo_invoice_id !== id)
              return [completion, ...filtered].slice(0, RECENT_LIMIT)
            })
            setDismissed(false)
            setLingerUntil(Date.now() + LINGER_MS)
          })()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      sb.removeChannel(channel)
    }
  }, [])

  function classify(r: Record<string, unknown>, finishedAt: number): Recent {
    const status = (r.billing_status as string | null) ?? null
    let outcome: Recent["outcome"] = "error"
    if (r.enrichment_ok === true || status === "ready_to_process" || status === "processed")
      outcome = "ready"
    else if (status === "needs_review") outcome = "review"
    return {
      qbo_invoice_id: String(r.qbo_invoice_id),
      doc_number: (r.doc_number as string | null) ?? null,
      customer_name: (r.customer_name as string | null) ?? null,
      outcome,
      needs_review_reason: (r.needs_review_reason as string | null) ?? null,
      finished_at: finishedAt,
    }
  }

  const counts = useMemo(() => {
    let ready = 0, review = 0, error = 0
    for (const r of recent) {
      if (r.outcome === "ready") ready++
      else if (r.outcome === "review") review++
      else error++
    }
    return { ready, review, error }
  }, [recent])

  const visible =
    !dismissed && recent.length > 0 &&
    lingerUntil !== null && Date.now() < lingerUntil

  if (!visible) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 pointer-events-auto">
      <div className="bg-bg-elev border border-line-soft rounded-lg shadow-2xl shadow-black/40 backdrop-blur-md min-w-[280px] max-w-[380px] overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-white/[0.03] transition-colors"
        >
          <Check className="w-4 h-4 text-grass" strokeWidth={2} />
          <div className="flex-1 text-left">
            <div className="text-[12px] text-ink font-medium">
              Pre-processed {recent.length} invoice{recent.length === 1 ? "" : "s"}
            </div>
            <div className="text-[10px] text-ink-mute">
              {counts.ready > 0 && `${counts.ready} ready`}
              {counts.review > 0 && ` · ${counts.review} to review`}
              {counts.error > 0 && ` · ${counts.error} failed`}
            </div>
          </div>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-ink-mute" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5 text-ink-mute" />
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              setDismissed(true)
            }}
            className="text-ink-mute hover:text-ink"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        </button>

        {expanded && (
          <div className="border-t border-line-soft/60 max-h-[280px] overflow-y-auto">
            {recent.map((r) => (
              <Link
                key={r.qbo_invoice_id}
                href={`/service-billing?invoice=${r.qbo_invoice_id}` as never}
                className="flex items-start gap-2.5 px-3.5 py-2 border-b border-line-soft/40 last:border-b-0 hover:bg-white/[0.03]"
              >
                {r.outcome === "ready" ? (
                  <Check className="w-3.5 h-3.5 text-grass mt-0.5" strokeWidth={2} />
                ) : (
                  <AlertTriangle
                    className={cn("w-3.5 h-3.5 mt-0.5",
                                  r.outcome === "review" ? "text-sun" : "text-coral")}
                    strokeWidth={2}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-ink truncate">
                    {r.doc_number ? `#${r.doc_number}` : r.qbo_invoice_id}
                    {r.customer_name ? ` · ${r.customer_name}` : ""}
                  </div>
                  {r.needs_review_reason && (
                    <div className="text-[10px] text-ink-mute truncate">
                      {r.needs_review_reason}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
