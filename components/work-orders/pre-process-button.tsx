"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"
import { ProgressModal } from "./progress-modal"

/**
 * Triggers f/service_billing/pre_process_invoice for the given invoice and
 * opens the live progress modal. Modal subscribes to billing.invoices via
 * Supabase Realtime and animates through each pre-process stage.
 */
export function PreProcessButton({ qboInvoiceId }: { qboInvoiceId: string }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [triggeredAt, setTriggeredAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    setBusy(true); setErr(null)
    try {
      const resp = await fetch("/api/billing/pre-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_id: qboInvoiceId, force: true }),
      })
      if (!resp.ok) {
        const body = await resp.text()
        throw new Error(body.slice(0, 200))
      }
      // Open the modal — it subscribes to Realtime and transitions as the
      // script writes stage updates. The fire-and-subscribe pattern avoids
      // polling.
      setTriggeredAt(Date.now())
      setModalOpen(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="default" onClick={onClick} disabled={busy}>
          <RefreshCw
            className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`}
            strokeWidth={2}
          />
          {busy ? "Queueing..." : "Re-run pre-processing"}
        </Button>
        {err && <span className="text-[11px] text-coral">{err}</span>}
      </div>
      <ProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        qboInvoiceId={qboInvoiceId}
        mode="pre_process"
        triggeredAt={triggeredAt ?? undefined}
      />
    </>
  )
}
