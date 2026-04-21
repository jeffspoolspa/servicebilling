"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { EyeOff, Eye } from "lucide-react"

/**
 * Skip / unskip a WO from active queues and audit views.
 * - Skipped: WO disappears from awaiting_invoice, billable-zero audit, and
 *   non-billable-with-charges audit. Useful when a billable WO won't get a QBO
 *   invoice (too old / mistake) or when you've reviewed an audit row and want
 *   to keep it as-is.
 * - Unskip: brings the row back into active views.
 */
interface SkipButtonProps {
  woNumber: string
  skipped: boolean
  skippedReason: string | null
}

export function SkipButton({ woNumber, skipped, skippedReason }: SkipButtonProps) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function doSkip() {
    const reason = window.prompt(
      "Reason for skipping (optional — e.g. 'too old, won't be invoiced' or 'audit reviewed, keep as non-billable')",
      skippedReason ?? "",
    )
    // window.prompt returns null if cancelled, "" if blank. Either way proceeds.
    if (reason === null) return

    setLoading(true); setErr(null)
    try {
      const resp = await fetch(`/api/work-orders/${woNumber}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setLoading(false)
    }
  }

  async function doUnskip() {
    if (!confirm("Unskip this WO? It will re-enter active queues.")) return
    setLoading(true); setErr(null)
    try {
      const resp = await fetch(`/api/work-orders/${woNumber}/skip`, { method: "DELETE" })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {skipped ? (
        <Button size="sm" variant="default" onClick={doUnskip} disabled={loading}>
          <Eye className="w-3.5 h-3.5" strokeWidth={2} />
          {loading ? "Unskipping..." : "Unskip"}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={doSkip} disabled={loading}>
          <EyeOff className="w-3.5 h-3.5" strokeWidth={2} />
          {loading ? "Skipping..." : "Skip"}
        </Button>
      )}
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </div>
  )
}
