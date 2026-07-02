"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * Mark a flagged customer-month reviewed/resolved (with a note) — this is what
 * releases the autopay/send hold. Re-flag puts the hold back.
 */
export function ReviewActions({
  customerId,
  month, // 'YYYY-MM-01'
  currentStatus,
  currentNote,
}: {
  customerId: number
  month: string
  currentStatus: string
  currentNote: string | null
}) {
  const router = useRouter()
  const [note, setNote] = useState(currentNote ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function setStatus(status: "reviewed" | "resolved" | "flagged") {
    setError(null)
    const resp = await fetch("/api/maintenance-billing/flags/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: customerId,
        month,
        status,
        note: note.trim() || null,
      }),
    })
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}))
      setError(json.error ?? `HTTP ${resp.status}`)
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Review note (what you checked / what was wrong / what was fixed in ION)"
        rows={3}
        className="w-full bg-bg-elev border border-line rounded px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-mute/60"
      />
      <div className="flex items-center gap-2">
        {currentStatus === "flagged" ? (
          <>
            <button
              onClick={() => setStatus("reviewed")}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-grass/30 text-grass bg-grass/10 hover:bg-grass/20 disabled:opacity-50"
            >
              Mark reviewed (release hold)
            </button>
            <button
              onClick={() => setStatus("resolved")}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
            >
              Mark resolved
            </button>
          </>
        ) : (
          <>
            {currentStatus === "reviewed" && (
              <button
                onClick={() => setStatus("resolved")}
                disabled={pending}
                className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
              >
                Mark resolved
              </button>
            )}
            <button
              onClick={() => setStatus("flagged")}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-coral/30 text-coral bg-coral/10 hover:bg-coral/20 disabled:opacity-50"
            >
              Re-flag (restore hold)
            </button>
          </>
        )}
      </div>
      {error && <div className="text-[11px] text-coral">{error}</div>}
    </div>
  )
}
