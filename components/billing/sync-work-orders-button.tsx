"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Workflow } from "lucide-react"

/**
 * Manually trigger the ION work-orders scrape (f/ION/work_orders flow).
 * Pulls 180 days of WOs, upserts into public.work_orders, reconciles
 * employee FKs. Same job that runs every 4h on cron — this is the
 * on-demand version.
 */
export function SyncWorkOrdersButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function onClick() {
    setLoading(true); setErr(null)
    try {
      const resp = await fetch("/api/work-orders/sync-all", { method: "POST" })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(body.slice(0, 200) || `HTTP ${resp.status}`)
      }
      // ION scrape typically 25-45s; refresh after 50s.
      setTimeout(() => {
        startTransition(() => router.refresh())
        setLoading(false)
      }, 50000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
      setLoading(false)
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <Button size={size} variant="default" onClick={onClick} disabled={loading}>
        <Workflow className={`w-3.5 h-3.5 ${loading ? "animate-pulse" : ""}`} strokeWidth={2} />
        {loading ? "Scraping..." : "Sync work orders from ION"}
      </Button>
      {err && <span className="text-[11px] text-coral max-w-[200px] truncate" title={err}>{err}</span>}
    </div>
  )
}
