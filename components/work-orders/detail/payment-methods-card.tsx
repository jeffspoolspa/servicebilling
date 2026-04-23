"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import type { PaymentMethod } from "@/lib/queries/dashboard"
import { formatDate } from "@/lib/utils/format"

/**
 * Payment methods card — shows only QBO-flagged defaults (one card + one ACH
 * max per customer). The one we'd charge is highlighted; if the other exists,
 * click it to override (`invoice.preferred_payment_type`). Matches
 * process_invoice.get_active_payment_method which filters to is_default=true
 * and honors the per-invoice override.
 *
 * Selection rule (mirrors the backend):
 *   1. If invoice.preferred_payment_type is set AND a default of that type
 *      exists, that one is highlighted.
 *   2. Else the most-recently-created default wins (matches QBO intent in
 *      98%+ of cases observed in production data).
 */
export function PaymentMethodsCard({
  qboInvoiceId,
  methods,
  preferredPaymentType,
  disabled = false,
}: {
  qboInvoiceId: string
  methods: PaymentMethod[]
  preferredPaymentType: "card" | "ach" | null
  disabled?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Already defaults-only + ordered qbo_created_at desc by the query.
  // Belt-and-suspenders: enforce both here too so this works even if the
  // caller passes an unfiltered list.
  const defaults = methods
    .filter((m) => m.is_default && m.is_active !== false)
    .sort((a, b) => {
      const ad = a.qbo_created_at ?? ""
      const bd = b.qbo_created_at ?? ""
      return bd.localeCompare(ad)
    })

  // Determine the selected one
  const selected = (() => {
    if (preferredPaymentType) {
      const match = defaults.find((m) => m.type === preferredPaymentType)
      if (match) return match
    }
    return defaults[0] ?? null
  })()

  async function switchTo(targetType: "card" | "ach" | null) {
    setError(null)
    const res = await fetch(
      `/api/billing/invoices/${qboInvoiceId}/preferred-payment-type`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: targetType }),
      },
    )
    if (!res.ok) {
      const { error: msg } = await res.json().catch(() => ({ error: "update failed" }))
      setError(msg || "update failed")
      return
    }
    startTransition(() => router.refresh())
  }

  if (defaults.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Payment method on file</CardTitle>
          <span className="ml-auto text-[11px] text-ink-mute">none</span>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          No default card or ACH on file — invoice will be emailed.
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment method on file</CardTitle>
        <span className="ml-auto text-[11px] text-ink-mute">
          {defaults.length === 2 ? "click to switch" : "QBO default"}
        </span>
      </CardHeader>
      <div className="flex flex-col">
        {defaults.map((m) => {
          const isSelected = selected?.id === m.id
          const canSwitchTo = !isSelected && defaults.length > 1
          const isUserOverride =
            isSelected && preferredPaymentType === m.type

          return (
            <button
              key={m.id}
              type="button"
              disabled={!canSwitchTo || disabled || pending}
              onClick={() => switchTo(m.type as "card" | "ach")}
              className={
                "px-5 py-3 border-b border-line-soft last:border-b-0 text-left " +
                "flex items-center justify-between text-[12px] transition-colors " +
                (isSelected
                  ? "bg-cyan/[0.06] border-l-2 border-l-cyan"
                  : canSwitchTo
                    ? "hover:bg-white/[0.02] cursor-pointer"
                    : "opacity-60")
              }
              title={
                canSwitchTo
                  ? `Switch to ${m.type === "card" ? "card" : "ACH"}`
                  : isSelected
                    ? "This is the method that will be charged"
                    : undefined
              }
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={
                    "inline-flex shrink-0 w-8 h-8 rounded-full items-center justify-center text-[10px] uppercase tracking-wider font-medium " +
                    (m.type === "card"
                      ? "bg-cyan/10 text-cyan"
                      : "bg-teal/10 text-teal")
                  }
                >
                  {m.type === "card" ? "Card" : "ACH"}
                </span>
                <div className="min-w-0">
                  <div className="text-ink truncate">
                    {m.card_brand ?? (m.type === "card" ? "Card" : "Bank")}
                    <span className="text-ink-mute"> · </span>
                    <span className="font-mono">
                      ···{m.last_four ?? "—"}
                    </span>
                  </div>
                  <div className="text-ink-mute text-[10px] mt-0.5">
                    added {m.qbo_created_at ? formatDate(m.qbo_created_at) : "—"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isSelected ? (
                  <Pill tone="cyan" dot className="text-[10px]">
                    will charge
                  </Pill>
                ) : (
                  <span className="text-[11px] text-cyan">use this →</span>
                )}
                {isUserOverride && (
                  <Pill tone="neutral" className="text-[10px]">
                    override
                  </Pill>
                )}
              </div>
            </button>
          )
        })}
      </div>
      {error && (
        <CardBody className="border-t border-line-soft text-[11px] text-coral">
          {error}
        </CardBody>
      )}
      {preferredPaymentType && defaults.length > 1 && (
        <CardBody className="border-t border-line-soft text-[11px] text-ink-mute flex items-center justify-between">
          <span>Using override — QBO&apos;s default is the other one.</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => switchTo(null)}
            className="text-cyan hover:underline disabled:opacity-50"
          >
            reset to default
          </button>
        </CardBody>
      )}
    </Card>
  )
}
