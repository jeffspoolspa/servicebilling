"use client"

import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Bulk "re-run pre-processing" trigger. Pass a list of qbo_invoice_ids and
 * an optional label; the button fires /api/billing/bulk-pre-process on
 * click and defers all progress observation to the global PreProcessActivity
 * toast in the shell.
 *
 * Used on:
 *   - /service-billing/queue (via QueueActions footer, multi-select)
 *   - /service-billing/needs-attention (top of page, "re-run everything visible")
 *   - any future page that wants to bulk-fire pre-processing
 *
 * Confirms with the user when N > 10 — prevents accidental "I clicked the
 * wrong button and now 200 jobs are queued" surprise.
 */
export function BulkRerunButton({
  qboInvoiceIds,
  label,
  size = "sm",
  variant = "ghost",
  className,
}: {
  qboInvoiceIds: string[]
  /** Defaults to "Re-run pre-process (N)". */
  label?: string
  size?: "sm" | "md"
  variant?: "primary" | "default" | "ghost"
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const ids = qboInvoiceIds.filter(Boolean)
  const n = ids.length

  async function fire() {
    if (n === 0 || busy) return
    if (n > 10) {
      const ok = window.confirm(
        `Re-run pre-processing on ${n} invoices? They'll queue under Windmill's concurrency limit and progress will appear in the toast at the bottom-right.`,
      )
      if (!ok) return
    }
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      const resp = await fetch("/api/billing/bulk-pre-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_ids: ids, force: true }),
      })
      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(txt.slice(0, 300) || `HTTP ${resp.status}`)
      }
      const body = (await resp.json()) as { queued: number; failed: number }
      setNote(
        body.failed > 0
          ? `Queued ${body.queued} (${body.failed} failed) — watch the toast`
          : `Queued ${body.queued} — watch the toast`,
      )
      setTimeout(() => setNote(null), 5000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={"flex items-center gap-2 " + (className ?? "")}>
      {err && (
        <span className="text-[11px] text-coral max-w-[300px] truncate" title={err}>
          {err}
        </span>
      )}
      {note && !err && <span className="text-[11px] text-cyan">{note}</span>}
      <Button
        size={size}
        variant={variant}
        onClick={fire}
        disabled={busy || n === 0}
        title={
          n === 0
            ? "Nothing to re-run"
            : `Re-run pre-processing on ${n} invoice${n === 1 ? "" : "s"}`
        }
      >
        <RefreshCw
          className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`}
          strokeWidth={2}
        />
        {busy ? "Queueing..." : (label ?? `Re-run pre-process (${n})`)}
      </Button>
    </div>
  )
}
