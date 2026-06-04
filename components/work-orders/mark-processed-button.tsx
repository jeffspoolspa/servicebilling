"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CheckCheck } from "lucide-react"
import { formatCurrency } from "@/lib/utils/format"
import { useCanWrite } from "@/components/providers/access-provider"

/**
 * Force an invoice to 'processed' WITHOUT charging or emailing.
 *
 * DB-only flip via the force_mark_processed RPC (allowed only from
 * needs_review / ready_to_process). No QBO write, no charge, no receipt.
 *
 * Use for invoices that are already settled (paid outside this flow, written
 * off, etc.) and should never be sent — this closes them out of the billing
 * queue without firing the charge/send path. Distinct from Skip (which drops
 * the WO/invoice from queues but leaves billing_status untouched).
 */
export function MarkProcessedButton({
  qboInvoiceId,
  balance,
}: {
  qboInvoiceId: string
  balance: number
}) {
  const _canWriteService = useCanWrite("service")
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function doMark() {
    const balNote =
      balance > 0
        ? `Heads up: this invoice still shows a ${formatCurrency(balance)} balance. `
        : ""
    if (
      !confirm(
        `${balNote}Mark this invoice as processed WITHOUT charging or sending?\n\n` +
          `Use only for invoices that are already settled and should never be ` +
          `emailed. This closes it out of the billing queue — no card charge, ` +
          `no receipt email.`,
      )
    )
      return
    setLoading(true)
    setErr(null)
    try {
      const resp = await fetch(`/api/billing/invoices/${qboInvoiceId}/mark-processed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setLoading(false)
    }
  }

  // UX gate (server enforces; this hides the button when viewer):
  if (!_canWriteService) return null
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={doMark} disabled={loading}>
        <CheckCheck className="w-3.5 h-3.5" strokeWidth={2} />
        {loading ? "Marking…" : "Mark processed"}
      </Button>
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </div>
  )
}
