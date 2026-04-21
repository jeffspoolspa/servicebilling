"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CloudDownload } from "lucide-react"

/**
 * Manual per-WO sync from QBO.
 * Triggers f/service_billing/sync_wo which:
 *   1. Fetches the QBO invoice by DocNumber (live)
 *   2. Caches it in billing.invoices
 *   3. Links the WO via qbo_invoice_id
 *   4. Runs pre-processing with force=True
 *
 * Useful when office just entered an invoice_number in ION and you don't
 * want to wait for the next 4h pull cycle.
 */
export function SyncButton({ woNumber }: { woNumber: string }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function onClick() {
    setLoading(true); setErr(null)
    try {
      const resp = await fetch(`/api/work-orders/${woNumber}/sync`, { method: "POST" })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      // sync_wo + pre_process_invoice typically completes in 10-20s
      setTimeout(() => {
        startTransition(() => router.refresh())
        setLoading(false)
      }, 15000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="default" onClick={onClick} disabled={loading}>
        <CloudDownload className={`w-3.5 h-3.5 ${loading ? "animate-pulse" : ""}`} strokeWidth={2} />
        {loading ? "Syncing..." : "Sync from QBO"}
      </Button>
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </div>
  )
}
