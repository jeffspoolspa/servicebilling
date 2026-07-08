"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, X, Loader2, AlertTriangle, Clock } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { Sheet } from "@/components/ui/sheet"

/**
 * DB-driven processing queue pill — the QueueChip's sibling for charge runs.
 * Appears (on every billing tab, any browser, surviving reloads) whenever a
 * seeded queue row or recent attempt exists: process_maint_period seeds
 * billing_audit.maint_process_queue at run start, so the pill knows the FULL
 * batch from the first second. Polls maint_billing_recent_processing every
 * 2s; click opens a Sheet with the whole queue in processing order — queued,
 * the one in flight (loading), and each outcome, labeled charged (autopay)
 * vs sent (email). Purely a viewer — the run is server-side and owns itself.
 */

interface Row {
  period_id: string
  customer_name: string | null
  doc_number: string | null
  attempt_status: string | null
  channel: string | null
  email_sent: boolean | null
  charge_amount: number | null
  qbo_payment_id: string | null
  error_message: string | null
  attempted_at: string
  processing_status: string | null
  qbo_balance: number | null
  queue_order: number | null
}

type Kind = "queued" | "running" | "done" | "warn" | "failed"

function derive(r: Row): { kind: Kind; label: string; detail?: string } {
  const processed = r.processing_status === "processed"
  const amt = r.charge_amount != null ? `$${Number(r.charge_amount).toFixed(2)}` : null
  switch (r.attempt_status) {
    case "queued":
      return { kind: "queued", label: "queued" }
    case "pending":
      return r.channel === "email"
        ? { kind: "running", label: "sending invoice…" }
        : { kind: "running", label: "charging…" }
    case "charge_succeeded":
      return r.qbo_payment_id
        ? { kind: "running", label: "sending emails…" }
        : { kind: "running", label: "recording payment…" }
    case "succeeded":
      return r.channel === "email"
        ? { kind: "done", label: "sent", detail: "invoice emailed (no autopay)" }
        : {
            kind: "done",
            label: "charged",
            detail: `${amt ?? "?"} · autopay (${r.channel ?? "card"})${r.email_sent ? " · receipt sent" : ""}`,
          }
    case "charge_declined":
      return processed
        ? { kind: "warn", label: "declined · invoiced", detail: r.error_message ?? undefined }
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
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [open, setOpen] = useState(false)
  const prevResolvedRef = useRef(0)
  const lastRefreshRef = useRef(0)

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

  // queue order = the order the run works through; resolved rows keep their
  // slot so the sheet reads top-to-bottom like a checklist
  const derived = rows
    .map((r) => ({ r, d: derive(r) }))
    .sort((a, b) => (a.r.queue_order ?? Infinity) - (b.r.queue_order ?? Infinity))
  const queued = derived.filter(({ d }) => d.kind === "queued").length
  const running = derived.filter(({ d }) => d.kind === "running").length
  const active = queued + running
  const resolved = derived.length - active

  // rows fall off Ready / land in Processed AS the run works: refresh the
  // page data when new rows resolve (throttled), and once more at the end
  useEffect(() => {
    if (resolved === prevResolvedRef.current) return
    prevResolvedRef.current = resolved
    const now = Date.now()
    if (active === 0 || now - lastRefreshRef.current > 4000) {
      lastRefreshRef.current = now
      router.refresh()
    }
  }, [resolved, active, router])

  if (rows.length === 0) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-colors self-center ${
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

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Processing queue"
        description={
          active > 0
            ? `${resolved} of ${derived.length} resolved · ${running} in flight · ${queued} waiting`
            : `${derived.length} resolved · finishes linger 10 min`
        }
      >
        <div className="divide-y divide-line-soft/40 -mx-1">
          {derived.map(({ r, d }) => (
            <div
              key={r.period_id}
              className={`flex items-center gap-3 px-1 py-2.5 ${d.kind === "queued" ? "opacity-55" : ""}`}
            >
              <StateIcon kind={d.kind} label={d.label} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-ink truncate">
                  {r.customer_name ?? "?"}
                  {r.doc_number && (
                    <span className="text-ink-mute font-mono text-[10px]"> #{r.doc_number}</span>
                  )}
                </div>
                {d.detail && (
                  <div className="text-[10.5px] text-ink-mute break-words">{d.detail}</div>
                )}
              </div>
              {r.qbo_balance != null && d.kind === "queued" && (
                <span className="font-mono text-[11px] text-ink-dim shrink-0">
                  ${Number(r.qbo_balance).toFixed(2)}
                </span>
              )}
              <span
                className={`text-[10.5px] shrink-0 ${
                  d.kind === "done"
                    ? "text-grass"
                    : d.kind === "running"
                      ? "text-cyan"
                      : d.kind === "queued"
                        ? "text-ink-mute"
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
      </Sheet>
    </>
  )
}

function StateIcon({ kind, label }: { kind: Kind; label: string }) {
  switch (kind) {
    case "queued":
      return (
        <div className="w-6 h-6 rounded-full border border-line bg-bg-elev flex items-center justify-center shrink-0">
          <Clock className="w-3 h-3 text-ink-mute" strokeWidth={1.8} />
        </div>
      )
    case "running":
      return (
        <div className="w-6 h-6 rounded-full border border-cyan/50 bg-cyan/15 flex items-center justify-center shrink-0">
          <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" strokeWidth={2} />
        </div>
      )
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
