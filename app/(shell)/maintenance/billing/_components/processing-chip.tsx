"use client"

import { useEffect, useRef, useState } from "react"
import { Check, X, Loader2, AlertTriangle, CreditCard, Mail, Receipt } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * DB-driven processing chip — the QueueChip's sibling for charge runs.
 * Appears (on every billing tab, any browser, surviving reloads) whenever
 * recent maintenance attempts exist: unresolved from the last 2 hours, or
 * anything from the last 10 minutes. Polls maint_billing_recent_processing
 * every 2s; click toggles a small anchored panel with per-invoice state.
 * Purely a viewer — the run is server-side and owns itself.
 */

interface Row {
  period_id: string
  customer_name: string | null
  doc_number: string | null
  attempt_status: string | null
  charge_amount: number | null
  qbo_payment_id: string | null
  error_message: string | null
  attempted_at: string
  processing_status: string | null
  qbo_balance: number | null
}

type Kind = "running" | "done" | "warn" | "failed"

function derive(r: Row): { kind: Kind; label: string; detail?: string } {
  const processed = r.processing_status === "processed"
  const amt = r.charge_amount != null ? `$${Number(r.charge_amount).toFixed(2)}` : null
  switch (r.attempt_status) {
    case "pending":
      return { kind: "running", label: "charging…" }
    case "charge_succeeded":
      return r.qbo_payment_id
        ? { kind: "running", label: "sending emails…" }
        : { kind: "running", label: "recording payment…" }
    case "succeeded":
      return { kind: "done", label: "succeeded", detail: amt ? `${amt} charged` : undefined }
    case "charge_declined":
      return processed
        ? { kind: "warn", label: "declined → invoiced → processed", detail: r.error_message ?? undefined }
        : { kind: "warn", label: "declined", detail: r.error_message ?? undefined }
    case "email_failed":
      return { kind: "warn", label: "email failed", detail: r.error_message ?? undefined }
    case "charge_uncertain":
      return { kind: "failed", label: "charge uncertain — halted", detail: r.error_message ?? undefined }
    case "payment_orphan":
      return { kind: "failed", label: "payment orphan — needs recovery", detail: r.error_message ?? undefined }
    default:
      return { kind: "failed", label: r.attempt_status ?? "?", detail: r.error_message ?? undefined }
  }
}

export function ProcessingChip() {
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const sb = createSupabaseBrowser()
    let cancelled = false
    async function poll() {
      const { data } = await sb.rpc("maint_billing_recent_processing")
      if (!cancelled && data) setRows(data as Row[])
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  if (rows.length === 0) return null

  const derived = rows.map((r) => ({ r, d: derive(r) }))
  const active = derived.filter(({ d }) => d.kind === "running").length
  const resolved = derived.length - active

  return (
    <div className="relative self-center" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-colors ${
          active > 0
            ? "border-teal/30 bg-teal/10 text-teal hover:bg-teal/20"
            : "border-grass/30 bg-grass/10 text-grass hover:bg-grass/20"
        }`}
      >
        {active > 0 ? (
          <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
        ) : (
          <Check className="w-3 h-3" strokeWidth={2.5} />
        )}
        Processing · {resolved}/{derived.length}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[26rem] z-30 bg-[#0E1C2A] border border-line rounded-lg shadow-2xl">
          <div className="px-4 py-2.5 border-b border-line-soft text-[11px] text-ink-mute">
            {active} in flight · {resolved} resolved · finishes linger 10 min
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-line-soft/40">
            {derived.map(({ r, d }) => (
              <div key={r.period_id} className="flex items-center gap-2.5 px-4 py-2">
                <StateIcon kind={d.kind} label={d.label} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-ink truncate">
                    {r.customer_name ?? "?"}
                    {r.doc_number && (
                      <span className="text-ink-mute font-mono text-[10px]"> #{r.doc_number}</span>
                    )}
                  </div>
                  {d.detail && (
                    <div className="text-[10px] text-ink-mute break-words">{d.detail}</div>
                  )}
                </div>
                <span
                  className={`text-[10px] shrink-0 ${
                    d.kind === "done"
                      ? "text-grass"
                      : d.kind === "running"
                        ? "text-cyan"
                        : d.kind === "warn"
                          ? "text-sun"
                          : "text-coral"
                  }`}
                >
                  {d.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StateIcon({ kind, label }: { kind: Kind; label: string }) {
  switch (kind) {
    case "running": {
      const Icon = label.startsWith("charging")
        ? CreditCard
        : label.startsWith("recording")
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
