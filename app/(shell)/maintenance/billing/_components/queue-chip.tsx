"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Loader2, X } from "lucide-react"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * Preprocess-queue activity chip: appears in the stage-tabs row whenever the
 * queue has unfinished work, with the count. Click toggles a small anchored
 * panel (not a screen-takeover) showing the rows draining live — running
 * first, then waiting in queue order, with the last few finishes.
 * Polls maint_billing_preprocess_queue every 3s while visible.
 */

interface QueueRow {
  qbo_customer_id: string
  customer_name: string | null
  billing_month: string
  enqueued_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  attempts: number
}

export function QueueChip() {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const sb = createSupabaseBrowser()
    let cancelled = false
    async function poll() {
      const { data } = await sb.rpc("maint_billing_preprocess_queue")
      if (!cancelled && data) setRows(data as QueueRow[])
    }
    poll()
    const interval = setInterval(poll, 3000)
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

  const pending = rows.filter((r) => !r.finished_at)
  if (pending.length === 0) return null
  const running = pending.filter((r) => r.started_at)
  const doneRecent = rows.filter((r) => r.finished_at)

  return (
    <div className="relative ml-auto self-center" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan/10 text-cyan px-3 py-1 text-[11px] hover:bg-cyan/20 transition-colors"
      >
        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
        Preprocessing · {pending.length}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 z-30 bg-[#0E1C2A] border border-line rounded-lg shadow-2xl">
          <div className="px-4 py-2.5 border-b border-line-soft text-[11px] text-ink-mute">
            {running.length} running · {pending.length - running.length} waiting ·{" "}
            {doneRecent.length} finished (last 3 min)
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-line-soft/40">
            {rows.slice(0, 60).map((r) => (
              <div
                key={`${r.qbo_customer_id}-${r.billing_month}-${r.enqueued_at}`}
                className="flex items-center gap-2.5 px-4 py-1.5"
              >
                {r.finished_at ? (
                  r.error ? (
                    <X className="w-3.5 h-3.5 text-coral shrink-0" strokeWidth={2.5} />
                  ) : (
                    <Check className="w-3.5 h-3.5 text-grass shrink-0" strokeWidth={2.5} />
                  )
                ) : r.started_at ? (
                  <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin shrink-0" strokeWidth={2} />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-line shrink-0" />
                )}
                <div className="flex-1 min-w-0 text-[12px] text-ink truncate">
                  {r.customer_name ?? r.qbo_customer_id}
                </div>
                <div className="text-[10px] text-ink-mute shrink-0">
                  {r.finished_at
                    ? r.error
                      ? `error (try ${r.attempts})`
                      : "done"
                    : r.started_at
                      ? "preprocessing"
                      : "queued"}
                </div>
              </div>
            ))}
            {pending.length > 60 && (
              <div className="px-4 py-2 text-[11px] text-ink-mute">
                +{pending.length - 60} more in queue
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
