"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"

/**
 * Manually trigger a full QBO invoice sync (same as the 4h cron).
 * Pulls every billable WO's invoice that's missing/stale, links them, seeds
 * status. Use when you want immediate refresh instead of waiting for the
 * next cycle.
 */
export function SyncAllButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function onClick() {
    setLoading(true); setErr(null)
    try {
      const resp = await fetch("/api/billing/sync-all", { method: "POST" })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(body.slice(0, 200) || `HTTP ${resp.status}`)
      }
      // Bulk pull: typically 30-60s for the full set. Refresh after 45s.
      setTimeout(() => {
        startTransition(() => router.refresh())
        setLoading(false)
      }, 45000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
      setLoading(false)
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <Button size={size} variant="default" onClick={onClick} disabled={loading}>
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} strokeWidth={2} />
        {loading ? "Syncing..." : "Sync invoices from QBO"}
      </Button>
      {err && (
        <span className="text-[11px] text-coral max-w-[200px] truncate" title={err}>
          {err}
        </span>
      )}
    </div>
  )
}
