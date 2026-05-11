"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import type { PaymentMethod } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Payment methods card — shows EVERY active PM QBO has on file for the
 * customer, independent of billing preference. The card simply mirrors
 * what's in QBO's wallet; whether we'd auto-charge it is a separate
 * concern (driven by Customers.preferred_payment_type +
 * invoices.preferred_payment_type).
 *
 * Selection rule (which row is highlighted as "will charge"):
 *   1. If invoice.preferred_payment_type is set AND an active PM of
 *      that type exists, that PM wins (per-invoice override).
 *   2. Else the QBO-flagged default wins (most recent if multiple).
 *   3. Else the most-recently-added active PM (handles the common case
 *      where QBO's default flag was never toggled, e.g. Country Inn).
 *
 * "is_default" is preserved as a visual badge but no longer gates display.
 */
/** PM-card subset of preferred_payment_type — only the values that can name
 *  a specific payment instrument. 'email' isn't surfaced here because it
 *  doesn't pick a card/ACH; that case is handled by the empty state below. */
type PmCardChannel = "credit_card" | "ach"

/** Normalize legacy 'card' → 'credit_card' so this component can safely
 *  accept both vocab eras during the rollout. */
function normalizeChannel(
  v: string | null | undefined,
): PmCardChannel | null {
  if (v === "credit_card" || v === "card") return "credit_card"
  if (v === "ach") return "ach"
  return null
}

export function PaymentMethodsCard({
  qboInvoiceId,
  methods,
  preferredPaymentType,
  disabled = false,
  invoiceBalance = null,
}: {
  qboInvoiceId: string
  methods: PaymentMethod[]
  /** Accepts the new vocab ('email' | 'ach' | 'credit_card') from invoices.preferred_payment_type
   *  AND legacy ('card' | 'ach') for backwards compat. Normalized internally. */
  preferredPaymentType: "email" | "ach" | "credit_card" | "card" | null
  disabled?: boolean
  /** Open balance on the invoice. When > 0 AND disabled (processed), each
   *  card row gets a "Charge $X.XX" button to recover the balance. */
  invoiceBalance?: number | null
}) {
  const normalizedPreferred = normalizeChannel(preferredPaymentType)
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // All active PMs, ordered: defaults first, then most-recently-added.
  // Defense in depth — server orders the same way; this re-sort handles
  // any caller that passes an unsorted list.
  const active = methods
    .filter((m) => m.is_active !== false)
    .sort((a, b) => {
      // Defaults float to top
      const ad0 = a.is_default ? 0 : 1
      const bd0 = b.is_default ? 0 : 1
      if (ad0 !== bd0) return ad0 - bd0
      const ad = a.qbo_created_at ?? ""
      const bd = b.qbo_created_at ?? ""
      return bd.localeCompare(ad)
    })

  // Determine the selected one — three-tier priority (override → default → newest).
  const selected = (() => {
    if (normalizedPreferred) {
      const match = active.find((m) => normalizeChannel(m.type) === normalizedPreferred)
      if (match) return match
    }
    const def = active.find((m) => m.is_default)
    if (def) return def
    return active[0] ?? null
  })()

  async function switchTo(targetType: PmCardChannel | null) {
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

  // Tracks which PM is mid-charge so its row can show a spinner / lock.
  const [chargingPmId, setChargingPmId] = useState<string | null>(null)

  async function chargeBalance(pmId: string, channel: PmCardChannel) {
    if (chargingPmId) return
    if (!confirm(
      `Charge ${formatCurrency(invoiceBalance ?? 0)} to this card? ` +
      `This creates a new processing attempt and posts a QBO Payment when the charge clears.`
    )) return
    setError(null)
    setChargingPmId(pmId)
    try {
      const res = await fetch(
        `/api/billing/invoices/${qboInvoiceId}/charge-balance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target_payment_method_id: pmId,
            channel,
          }),
        },
      )
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: "charge failed" }))
        throw new Error(msg || `${res.status}`)
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : "charge failed")
    } finally {
      setChargingPmId(null)
    }
  }

  // True when a per-card "Charge $X.XX" button should render. Conditions:
  //  - the card area is disabled (i.e. invoice already processed in the
  //    primary flow — that's where this recovery action belongs), AND
  //  - there's an actual open balance to recover.
  const canChargeBalance =
    disabled && invoiceBalance != null && invoiceBalance > 0

  if (active.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Payment method on file</CardTitle>
          <span className="ml-auto text-[11px] text-ink-mute">none</span>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          No card or ACH on file — invoice will be emailed.
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment method on file</CardTitle>
        <span className="ml-auto text-[11px] text-ink-mute">
          {canChargeBalance
            ? `${formatCurrency(invoiceBalance ?? 0)} open balance`
            : disabled
              ? "read-only — invoice is processed"
              : active.length > 1
                ? "click to switch"
                : "on file"}
        </span>
      </CardHeader>
      <div className="flex flex-col">
        {active.map((m) => {
          const isSelected = selected?.id === m.id
          const canSwitchTo = !isSelected && active.length > 1
          const isUserOverride =
            isSelected && normalizedPreferred === normalizeChannel(m.type)

          return (
            <button
              key={m.id}
              type="button"
              disabled={!canSwitchTo || disabled || pending}
              onClick={() => {
                const ch = normalizeChannel(m.type)
                if (ch) switchTo(ch)
              }}
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
                  ? `Switch to ${normalizeChannel(m.type) === "credit_card" ? "card" : "ACH"}`
                  : isSelected
                    ? "This is the method that will be charged"
                    : undefined
              }
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={
                    "inline-flex shrink-0 w-8 h-8 rounded-full items-center justify-center text-[10px] uppercase tracking-wider font-medium " +
                    (normalizeChannel(m.type) === "credit_card"
                      ? "bg-cyan/10 text-cyan"
                      : "bg-teal/10 text-teal")
                  }
                >
                  {normalizeChannel(m.type) === "credit_card" ? "Card" : "ACH"}
                </span>
                <div className="min-w-0">
                  <div className="text-ink truncate">
                    {m.card_brand ?? (normalizeChannel(m.type) === "credit_card" ? "Card" : "Bank")}
                    <span className="text-ink-mute"> · </span>
                    <span className="font-mono">
                      ···{m.last_four ?? "—"}
                    </span>
                  </div>
                  <div className="text-ink-mute text-[10px] mt-0.5 flex items-center gap-1.5">
                    <span>added {m.qbo_created_at ? formatDate(m.qbo_created_at) : "—"}</span>
                    {m.is_default && (
                      <span className="text-[9px] uppercase tracking-[0.06em] text-ink-dim border border-line-soft rounded px-1 py-px">
                        QBO default
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div
                className="flex items-center gap-2 shrink-0"
                onClick={(e) => {
                  // The outer <button> wraps the row and would re-fire
                  // switchTo() if we don't stop propagation here. The
                  // inner Charge button has its own onClick.
                  if (canChargeBalance) e.stopPropagation()
                }}
              >
                {canChargeBalance ? (
                  <button
                    type="button"
                    disabled={chargingPmId !== null}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const ch = normalizeChannel(m.type)
                      if (ch) chargeBalance(m.id, ch)
                    }}
                    className={
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] " +
                      "border transition-colors " +
                      (chargingPmId === m.id
                        ? "border-cyan bg-cyan/15 text-cyan opacity-80 cursor-wait"
                        : "border-cyan/40 bg-cyan/10 text-cyan hover:border-cyan/70 hover:bg-cyan/20")
                    }
                    title={
                      `Charge ${formatCurrency(invoiceBalance ?? 0)} to this card. ` +
                      `Creates a new processing attempt.`
                    }
                  >
                    {chargingPmId === m.id
                      ? "Charging…"
                      : `Charge ${formatCurrency(invoiceBalance ?? 0)}`}
                  </button>
                ) : isSelected ? (
                  <Pill tone="cyan" dot className="text-[10px]">
                    {disabled ? "selected" : "will charge"}
                  </Pill>
                ) : !disabled ? (
                  <span className="text-[11px] text-cyan">use this →</span>
                ) : null}
                {isUserOverride && !canChargeBalance && (
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
      {normalizedPreferred && active.length > 1 && !disabled && (
        <CardBody className="border-t border-line-soft text-[11px] text-ink-mute flex items-center justify-between">
          <span>Per-invoice override — clear to fall back to the QBO default selection.</span>
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
