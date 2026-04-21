"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Undo2 } from "lucide-react"

/**
 * Flip a ready_to_process invoice back to needs_review so the user can edit
 * classification and re-run pre-processing. Useful when the memo or class
 * looks wrong after auto-enrichment.
 *
 * Lightweight — no modal, just inline confirmation on second click.
 */
export function RevertButton({ qboInvoiceId }: { qboInvoiceId: string }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function fire() {
    setBusy(true); setErr(null)
    try {
      const resp = await fetch(`/api/billing/invoices/${qboInvoiceId}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "user_revert" }),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
      setArmed(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {armed ? (
        <>
          <span className="text-[11px] text-ink-mute">Move back to needs review?</span>
          <Button size="sm" variant="default" onClick={fire} disabled={busy}>
            {busy ? "Reverting..." : "Yes, revert"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setArmed(false)} disabled={busy}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setArmed(true)}>
          <Undo2 className="w-3.5 h-3.5" strokeWidth={2} />
          Revert to Review
        </Button>
      )}
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </div>
  )
}
