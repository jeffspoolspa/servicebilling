"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CreditCard, Eye } from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import { ProgressModal } from "./progress-modal"

/**
 * Per-invoice Process button. Sits on the WO detail page when billing_status
 * is ready_to_process. One click fires processing — no type-to-confirm gate
 * because the checks before this button (credit recheck, default-only card
 * picker, live QBO fetch, idempotency key) already ensure the charge is
 * deliberate. Dry-run is right next to it for inspection without money moving.
 *
 * Wraps a single invoice instead of the batch version in QueueActions — same
 * API route under the hood.
 */

interface Props {
  qboInvoiceId: string
  balance: number
  paymentMethod: "on_file" | "invoice" | string | null
}

export function ProcessButton({ qboInvoiceId, balance, paymentMethod }: Props) {
  const [busy, setBusy] = useState<"dry" | "live" | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [triggeredAt, setTriggeredAt] = useState<number | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function fire(dry: boolean) {
    setBusy(dry ? "dry" : "live")
    setErr(null)
    try {
      const resp = await fetch("/api/billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_id: qboInvoiceId, dry_run: dry }),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 300))
      if (dry) {
        // Dry-run finishes fast, no need for a live modal — just refresh
        setTimeout(() => {
          startTransition(() => router.refresh())
          setBusy(null)
        }, 4000)
      } else {
        // Live charge: open the progress modal, let the user watch it go
        setTriggeredAt(Date.now())
        setModalOpen(true)
        setBusy(null)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown error")
      setBusy(null)
    }
  }

  // Will money actually move? Only when payment_method='on_file' AND there's
  // a non-zero balance left to collect. Drives button label only.
  const willCharge = paymentMethod === "on_file" && balance > 0

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="default" onClick={() => fire(true)} disabled={busy !== null}>
        <Eye className="w-3.5 h-3.5" strokeWidth={2} />
        {busy === "dry" ? "Dry-running..." : "Dry-run"}
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => fire(false)}
        disabled={busy !== null}
      >
        <CreditCard className="w-3.5 h-3.5" strokeWidth={2} />
        {busy === "live"
          ? "Processing..."
          : willCharge
            ? `Process (${formatCurrency(balance)})`
            : "Process"}
      </Button>
      {err && <span className="text-[11px] text-coral">{err}</span>}

      <ProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        qboInvoiceId={qboInvoiceId}
        mode="process"
        paymentMethod={paymentMethod === "on_file" ? "on_file" : "invoice"}
        willCharge={willCharge}
        triggeredAt={triggeredAt ?? undefined}
      />
    </div>
  )
}
