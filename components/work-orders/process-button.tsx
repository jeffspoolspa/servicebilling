"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CreditCard, Eye } from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import { ProgressModal } from "./progress-modal"

/**
 * Per-invoice Process button. Sits on the WO detail page when billing_status
 * is ready_to_process. Clicking primes the CHARGE confirmation modal (user
 * must type CHARGE to enable live processing). Also offers Dry-run as a
 * secondary action next to it.
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
  const [showConfirm, setShowConfirm] = useState<"live" | null>(null)
  const [confirmText, setConfirmText] = useState("")
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
      setShowConfirm(null)
      setConfirmText("")
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

  const label =
    paymentMethod === "on_file"
      ? `Charge ${formatCurrency(balance)}`
      : "Send invoice email"

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="default" onClick={() => fire(true)} disabled={busy !== null}>
        <Eye className="w-3.5 h-3.5" strokeWidth={2} />
        {busy === "dry" ? "Dry-running..." : "Dry-run"}
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          if (paymentMethod === "on_file" && balance > 0) {
            setShowConfirm("live")
          } else {
            // Invoice-only path is low-risk (just emails), no confirmation modal
            fire(false)
          }
        }}
        disabled={busy !== null}
      >
        <CreditCard className="w-3.5 h-3.5" strokeWidth={2} />
        {busy === "live"
          ? "Processing..."
          : paymentMethod === "on_file"
            ? "Process (Charge)"
            : "Process (Send)"}
      </Button>
      {err && <span className="text-[11px] text-coral">{err}</span>}

      <ProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        qboInvoiceId={qboInvoiceId}
        mode="process"
        paymentMethod={paymentMethod === "on_file" ? "on_file" : "invoice"}
        triggeredAt={triggeredAt ?? undefined}
      />
      {showConfirm === "live" && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowConfirm(null)
              setConfirmText("")
            }
          }}
        >
          <div className="bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-md w-full mx-6 p-6 space-y-4">
            <h3 className="text-lg font-medium text-ink">Process this invoice?</h3>
            <div className="text-sm text-ink-dim space-y-2">
              <p>
                This will <span className="text-coral font-medium">charge the card on file</span>{" "}
                for <span className="font-mono text-sun">{formatCurrency(balance)}</span> via QBO
                Payments and send invoice + receipt emails. Charges cannot be undone from this UI —
                refunds must be done in QBO.
              </p>
              <p className="text-xs">
                Type{" "}
                <code className="bg-bg-elev px-1.5 py-0.5 rounded text-coral">{label.toUpperCase().includes("CHARGE") ? "CHARGE" : "SEND"}</code>{" "}
                to enable the button.
              </p>
            </div>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
              placeholder="Type CHARGE"
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:border-cyan"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={() => { setShowConfirm(null); setConfirmText("") }}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => fire(false)}
                disabled={confirmText !== "CHARGE" || busy !== null}
              >
                {busy === "live" ? "Processing..." : label}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
