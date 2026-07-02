"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * Mark a customer-month reviewed/resolved (with a note). One table tracks
 * review state for both lists (billing_audit.customer_month_audit): a z-audit
 * row updates in place; a 2x-queue customer with no row gets a REVIEW_2X row
 * created (RPC upsert). Reviewing a HIGH releases the autopay/send hold;
 * re-flag restores it.
 */
export function ReviewActions({
  customerId,
  month, // 'YYYY-MM-01'
  currentStatus, // null = no audit row yet (2x-queue only)
  currentNote,
  isHold, // unreviewed HIGH -> reviewing releases the autopay/send hold
}: {
  customerId: number
  month: string
  currentStatus: string | null
  currentNote: string | null
  isHold: boolean
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

  const open = currentStatus == null || currentStatus === "flagged"

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
        {open ? (
          <>
            <button
              onClick={() => setStatus("reviewed")}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] font-medium rounded border border-grass/30 text-grass bg-grass/10 hover:bg-grass/20 disabled:opacity-50"
            >
              Mark reviewed{isHold ? " (release hold)" : ""}
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
              Re-flag
            </button>
          </>
        )}
      </div>
      {error && <div className="text-[11px] text-coral">{error}</div>}
    </div>
  )
}
