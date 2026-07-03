"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/**
 * Inline release for a needs_review customer-month with only DATA-mismatch
 * reasons (ion amount / subtotal / reconcile / credit error): mark reviewed ->
 * ready via the guarded RPC (stamps reviewed_at; re-projection re-holds a
 * still-unreviewed chem flag). chem_flag rows release via the drill-down's
 * flag review instead.
 */
export function ReviewQueueActions({ ids }: { ids: string[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function markReady() {
    setBusy(true)
    try {
      const r = await fetch("/api/maintenance-billing/periods/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status: "ready_to_process" }),
      })
      if (r.ok) router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      disabled={busy}
      onClick={markReady}
      className="text-[11px] px-2.5 py-1 rounded border border-teal/30 text-teal hover:bg-teal/10 disabled:opacity-50"
    >
      {busy ? "…" : "Mark reviewed → ready"}
    </button>
  )
}

/** Immediate preprocess retry for sticky op errors (enrichment/credit):
 *  enqueues the customer-month now — the drainer's next 2-minute tick
 *  re-runs it, instead of waiting out the 30-minute self-heal spacing. */
export function RetryPreprocess({
  qboCustomerId,
  month,
}: {
  qboCustomerId: string
  month: string
}) {
  const router = useRouter()
  const [state, setState] = useState<"idle" | "busy" | "queued">("idle")

  async function retry() {
    setState("busy")
    try {
      const r = await fetch("/api/maintenance-billing/preprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_customer_id: qboCustomerId, billing_month: month }),
      })
      setState(r.ok ? "queued" : "idle")
      if (r.ok) router.refresh()
    } catch {
      setState("idle")
    }
  }

  if (state === "queued")
    return <span className="text-[11px] text-cyan">queued — drainer picks it up ≤2 min</span>
  return (
    <button
      disabled={state === "busy"}
      onClick={retry}
      className="text-[11px] px-2.5 py-1 rounded border border-cyan/30 text-cyan hover:bg-cyan/10 disabled:opacity-50"
    >
      {state === "busy" ? "…" : "Retry preprocessing"}
    </button>
  )
}
