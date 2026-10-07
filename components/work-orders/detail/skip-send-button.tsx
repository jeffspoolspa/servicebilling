"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useCanWrite } from "@/components/providers/access-provider"

/**
 * Skip sending / Undo skip for an unsent invoice, or for a work order before
 * its invoice exists (the invoice inherits it when it links). Skipping waives delivery
 * (delivery_waived {reason: not_wanted}): the queue never emails it and the
 * Send invoice button is replaced by this until undone. A card charge is not
 * affected — only the email.
 */
export function SkipSendButton({
  apiPath,
  skipped,
}: {
  /** /api/billing/invoices/<id>/skip-send or /api/work-orders/<wo>/skip-send */
  apiPath: string
  skipped: boolean
}) {
  const canWrite = useCanWrite("service")
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(init: RequestInit, query = "") {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiPath}${query}`, init)
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: "failed" }))
        throw new Error(msg || `${res.status}`)
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed")
    } finally {
      setBusy(false)
    }
  }

  function skip() {
    // the note is what the next person reads in History
    const note = window.prompt("Skip sending this invoice? It will never be emailed. Why?", "")
    if (note === null) return
    void run({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    })
  }

  function undo() {
    const note = window.prompt("Undo the skip? The invoice can be sent again. What changed?", "")
    if (note === null) return
    void run({ method: "DELETE" }, `?note=${encodeURIComponent(note)}`)
  }

  if (!canWrite) return skipped ? <span className="text-ink-mute">send skipped</span> : null
  return (
    <>
      {skipped && <span className="text-ink-mute">send skipped</span>}
      <button
        onClick={skipped ? undo : skip}
        disabled={busy}
        className="text-[11px] text-ink-dim border border-line-soft rounded-md px-2 py-0.5 hover:bg-white/5 disabled:opacity-50"
        title={skipped ? "Allow this invoice to be sent again" : "Never email this invoice"}
      >
        {busy ? (skipped ? "Undoing…" : "Skipping…") : skipped ? "Undo skip" : "Skip sending"}
      </button>
      {error && (
        <span className="text-[11px] text-coral" title={error}>
          {error}
        </span>
      )}
    </>
  )
}
