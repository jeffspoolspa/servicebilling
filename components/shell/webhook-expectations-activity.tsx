"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { cn } from "@/lib/utils/cn"

/**
 * Global webhook expectations toast.
 *
 * Lives in the shell layout above PreProcessActivity. Subscribes to
 * billing.webhook_expectations via Realtime. When the user makes a write
 * (Save & mark ready, Apply Credit, etc.), the script inserts a row;
 * this component shows it as "Confirming…" with a spinner. When the
 * matching QBO webhook arrives and the row flips to confirmed, the
 * spinner becomes a green check and fades after a few seconds. If the
 * webhook never arrives within the grace window, the cdc_reconciler
 * flips the row to 'missing' and the indicator turns red.
 *
 * The user keeps working — this is non-blocking ambient feedback.
 *
 * Layout: fixed bottom-right, stacked above the PreProcessActivity toast.
 * Collapsed shows count + status pill. Click to expand: list of recent
 * expectations with entity type, id, and elapsed time.
 */

interface Expectation {
  id: string
  entity_type: string
  entity_id: string
  triggered_at: number // ms epoch
  status: "pending" | "confirmed" | "missing"
  source: string
  /** ms epoch — when this row should fade from the toast (for confirmed rows). */
  drop_at: number | null
}

// How long a confirmed row stays visible before fading out.
const CONFIRMED_LINGER_MS = 4_000
// Linger time after the queue empties before the toast itself hides.
const TOAST_LINGER_MS = 6_000
// Don't display rows older than this on initial seed (avoid showing stale state).
const SEED_MAX_AGE_MS = 5 * 60_000
// Max rows to show in expanded view.
const RECENT_LIMIT = 8

export function WebhookExpectationsActivity() {
  const [rows, setRows] = useState<Map<string, Expectation>>(new Map())
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [hideAt, setHideAt] = useState<number | null>(null)
  const [, forceTick] = useState(0)

  // Single periodic tick: re-renders for "Ns ago" counters AND drops rows
  // whose drop_at has passed.
  useEffect(() => {
    const id = setInterval(() => {
      forceTick((t) => t + 1)
      const now = Date.now()
      setRows((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, row] of prev) {
          if (row.drop_at !== null && row.drop_at < now) {
            next.delete(id)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Seed with recent expectations on mount — covers the case where the
  // user opened the app after kicking off writes from another tab.
  // Uses a server-side API endpoint because PostgREST doesn't expose the
  // billing schema directly; Realtime is wired up below for live updates.
  useEffect(() => {
    let cancelled = false

    // Lightweight initial fetch via API
    fetch("/api/sync/expectations/recent")
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((data: { rows: Array<Record<string, unknown>> }) => {
        if (cancelled) return
        const now = Date.now()
        const cutoff = now - SEED_MAX_AGE_MS
        const next = new Map<string, Expectation>()
        for (const r of data.rows ?? []) {
          const triggered = new Date(String(r.triggered_at)).getTime()
          if (triggered < cutoff) continue
          const status = String(r.status) as Expectation["status"]
          const drop_at =
            status === "confirmed"
              ? new Date(String(r.webhook_received_at ?? r.triggered_at)).getTime() +
                CONFIRMED_LINGER_MS
              : null
          if (status === "confirmed" && drop_at !== null && drop_at < now) continue
          next.set(String(r.id), {
            id: String(r.id),
            entity_type: String(r.entity_type),
            entity_id: String(r.entity_id),
            triggered_at: triggered,
            status,
            source: String(r.source),
            drop_at,
          })
        }
        setRows(next)
      })
      .catch(() => {
        // Soft-fail; the realtime sub will pick up new activity anyway.
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Realtime subscription — INSERTs (new pending) and UPDATEs (status flips).
  useEffect(() => {
    const sb = createSupabaseBrowser()
    const channel = sb
      .channel("webhook-expectations-activity")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "billing", table: "webhook_expectations" },
        (payload) => {
          const row = (payload as { new?: Record<string, unknown> }).new
          if (!row) return
          const triggered = new Date(String(row.triggered_at)).getTime()
          // Only display rows we know are recent. Skip historical re-plays.
          if (Date.now() - triggered > SEED_MAX_AGE_MS) return
          const id = String(row.id)
          setRows((prev) => {
            const next = new Map(prev)
            next.set(id, {
              id,
              entity_type: String(row.entity_type),
              entity_id: String(row.entity_id),
              triggered_at: triggered,
              status: String(row.status) as Expectation["status"],
              source: String(row.source),
              drop_at: null,
            })
            return next
          })
          setDismissed(false)
          setHideAt(null)
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "billing", table: "webhook_expectations" },
        (payload) => {
          const row = (payload as { new?: Record<string, unknown> }).new
          if (!row) return
          const id = String(row.id)
          const status = String(row.status) as Expectation["status"]
          setRows((prev) => {
            // Only react to UPDATEs for rows we're already tracking.
            // Avoids surfacing every random expectation across the system.
            if (!prev.has(id)) return prev
            const next = new Map(prev)
            const existing = next.get(id)!
            const drop_at =
              status === "confirmed" ? Date.now() + CONFIRMED_LINGER_MS : null
            next.set(id, { ...existing, status, drop_at })
            return next
          })
          if (status !== "confirmed") {
            // Missing or back to pending — make sure the toast is visible.
            setDismissed(false)
            setHideAt(null)
          }
        },
      )
      .subscribe()

    return () => {
      void sb.removeChannel(channel)
    }
  }, [])

  // When everything has resolved, schedule the toast to hide.
  useEffect(() => {
    const hasActive =
      [...rows.values()].some((r) => r.status === "pending" || r.status === "missing")
    if (hasActive) {
      setHideAt(null)
      return
    }
    if (rows.size === 0) return
    setHideAt(Date.now() + TOAST_LINGER_MS)
  }, [rows])

  const counts = useMemo(() => {
    let pending = 0
    let confirmed = 0
    let missing = 0
    for (const r of rows.values()) {
      if (r.status === "pending") pending++
      else if (r.status === "confirmed") confirmed++
      else if (r.status === "missing") missing++
    }
    return { pending, confirmed, missing }
  }, [rows])

  const visible =
    !dismissed &&
    (rows.size > 0 || (hideAt !== null && Date.now() < hideAt))

  if (!visible) return null

  const sorted = [...rows.values()].sort((a, b) => b.triggered_at - a.triggered_at)

  // Pick the dominant status for the header
  const headerKind: "pending" | "missing" | "confirmed" =
    counts.pending > 0
      ? "pending"
      : counts.missing > 0
        ? "missing"
        : "confirmed"

  return (
    // Stacked ABOVE PreProcessActivity (which sits at bottom-4). Bottom-24
    // gives ~80px clearance for the pre-process toast when both are visible.
    <div className="fixed bottom-24 right-4 z-40 pointer-events-auto">
      <div className="bg-bg-elev border border-line-soft rounded-lg shadow-2xl shadow-black/40 backdrop-blur-md min-w-[260px] max-w-[360px] overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-white/[0.03] transition-colors"
        >
          {headerKind === "pending" ? (
            <Loader2 className="w-4 h-4 text-cyan animate-spin" strokeWidth={2} />
          ) : headerKind === "missing" ? (
            <AlertTriangle className="w-4 h-4 text-coral" strokeWidth={2.5} />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-grass" strokeWidth={2.5} />
          )}
          <div className="flex-1 text-left">
            <div className="text-[12px] text-ink font-medium">
              {headerKind === "pending" && (
                <>
                  Confirming {counts.pending} write{counts.pending === 1 ? "" : "s"} with QBO
                </>
              )}
              {headerKind === "missing" && (
                <>
                  {counts.missing} write{counts.missing === 1 ? "" : "s"} unconfirmed
                </>
              )}
              {headerKind === "confirmed" && counts.pending === 0 && (
                <>All writes confirmed</>
              )}
            </div>
            <div className="text-[10px] text-ink-mute font-mono">
              {counts.confirmed > 0 && (
                <span className="text-grass">{counts.confirmed} confirmed</span>
              )}
              {counts.missing > 0 && (
                <>
                  {counts.confirmed > 0 && " · "}
                  <span className="text-coral">{counts.missing} missing</span>
                </>
              )}
            </div>
          </div>
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
            title="Dismiss (will reappear on next write)"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </span>
        </button>

        {expanded && (
          <div className="border-t border-line-soft max-h-[280px] overflow-y-auto px-3.5 py-2">
            <div className="flex flex-col gap-1">
              {sorted.slice(0, RECENT_LIMIT).map((r) => (
                <ExpectationRow key={r.id} row={r} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ExpectationRow({ row }: { row: Expectation }) {
  const elapsed = Math.max(0, Math.floor((Date.now() - row.triggered_at) / 1000))
  const Icon =
    row.status === "pending"
      ? Loader2
      : row.status === "missing"
        ? AlertTriangle
        : CheckCircle2
  const tone =
    row.status === "pending"
      ? "text-cyan"
      : row.status === "missing"
        ? "text-coral"
        : "text-grass"
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <Icon
        className={cn("w-3 h-3 shrink-0", tone, row.status === "pending" && "animate-spin")}
        strokeWidth={2.5}
      />
      <div className="font-mono text-ink-dim shrink-0 w-20 truncate">
        {row.entity_type}
      </div>
      <div className="font-mono text-ink-mute shrink-0 truncate flex-1">
        {row.entity_id}
      </div>
      <div className="font-mono text-ink-mute/70 tabular-nums shrink-0">
        {elapsed}s
      </div>
    </div>
  )
}
