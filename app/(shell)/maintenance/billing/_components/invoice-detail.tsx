"use client"

import { useEffect, useState } from "react"
import { InvoiceCard, type InvoiceCardData } from "@/components/billing/invoice-card"

/**
 * Self-fetching wrapper around the shared InvoiceCard (the repo's ONE invoice
 * rendering — same component the work-order detail uses). Fetches the cached
 * QBO invoice lazily via /api/maintenance-billing/invoice.
 */
export function InvoiceDetail({ qboInvoiceId }: { qboInvoiceId: string }) {
  const [inv, setInv] = useState<InvoiceCardData | "loading" | "error">("loading")

  useEffect(() => {
    let alive = true
    setInv("loading")
    fetch(`/api/maintenance-billing/invoice?qbo_invoice_id=${qboInvoiceId}`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setInv(j.invoice as InvoiceCardData))
      .catch(() => alive && setInv("error"))
    return () => {
      alive = false
    }
  }, [qboInvoiceId])

  if (inv === "loading")
    return <div className="text-[11px] text-ink-mute">Loading invoice…</div>
  if (inv === "error")
    return <div className="text-[11px] text-coral">Failed to load invoice detail.</div>

  return <InvoiceCard invoice={inv} />
}
