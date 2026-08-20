"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * "Send invoice" — the one human move for an unsent invoice. When a balance
 * is open it also switches the route to email (the API does it), which is
 * what clears a declined card: we stop trying to charge and the customer
 * pays the emailed invoice. The invoice then derives to paid or open A/R.
 */
export function SendInvoiceButton({
  qboInvoiceId,
  hasOpenBalance,
}: {
  qboInvoiceId: string
  hasOpenBalance: boolean
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (
      !confirm(
        hasOpenBalance
          ? "Email this invoice to the customer? It switches to the email route — we stop charging the card and they pay it themselves."
          : "Email the paid copy of this invoice to the customer?",
      )
    )
      return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/billing/invoices/${qboInvoiceId}/send`, { method: "POST" })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: "failed" }))
        throw new Error(msg || `${res.status}`)
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={send}
        disabled={busy}
        className="text-[11px] text-cyan border border-cyan/40 bg-cyan/10 rounded-md px-2 py-0.5 hover:bg-cyan/20 disabled:opacity-50"
        title={
          hasOpenBalance
            ? "Switch to the email route and send — moves this into open A/R"
            : "Send the paid copy — the last step before this counts as processed"
        }
      >
        {busy ? "Sending…" : "Send invoice"}
      </button>
      {error && (
        <span className="text-[11px] text-coral" title={error}>
          {error}
        </span>
      )}
    </>
  )
}
