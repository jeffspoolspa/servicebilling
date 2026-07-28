"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Landmark, Pencil, Mail, X, Check } from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Pill } from "@/components/ui/pill"
import type { PaymentMethod } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Compact payment-method card for the sidebar. Shows ONLY the method that
 * will charge — bank icon for ACH, brand chip for cards — with a count badge
 * (how many are on file) and a pencil that expands the full picker inline
 * (anchored expansion, not a modal). Selection + charge-balance recovery
 * reuse the same endpoints the old table card used.
 *
 * Selection rule (unchanged): per-invoice preferred type override → QBO
 * default → most recently added.
 */

type Channel = "credit_card" | "ach"

function normalize(v: string | null | undefined): Channel | null {
  if (v === "credit_card" || v === "card") return "credit_card"
  if (v === "ach") return "ach"
  return null
}

/** Brand chip — small styled abbreviation (no external assets; CSP-safe). */
function BrandIcon({ brand, type }: { brand: string | null; type: string }) {
  if (normalize(type) === "ach") {
    return (
      <span className="inline-flex w-9 h-6 rounded items-center justify-center bg-teal/10 border border-teal/30">
        <Landmark className="w-3.5 h-3.5 text-teal" strokeWidth={2} />
      </span>
    )
  }
  const b = (brand ?? "").toLowerCase()
  const meta = b.includes("visa")
    ? { label: "VISA", cls: "bg-[#1a1f71]/20 text-[#7d8bff] border-[#1a1f71]/50" }
    : b.includes("master")
      ? { label: "MC", cls: "bg-[#eb001b]/10 text-[#ff8a80] border-[#eb001b]/40" }
      : b.includes("amex") || b.includes("american")
        ? { label: "AMEX", cls: "bg-[#006fcf]/15 text-[#66b2ff] border-[#006fcf]/40" }
        : b.includes("discover")
          ? { label: "DISC", cls: "bg-[#ff6000]/10 text-[#ffab73] border-[#ff6000]/40" }
          : { label: "CARD", cls: "bg-cyan/10 text-cyan border-cyan/30" }
  return (
    <span
      className={`inline-flex w-9 h-6 rounded items-center justify-center text-[9px] font-semibold tracking-wide border ${meta.cls}`}
    >
      {meta.label}
    </span>
  )
}

export function PaymentMethodInline({
  qboInvoiceId,
  methods,
  preferredPaymentType,
  routeUnresolved,
  disabled = false,
  invoiceBalance = null,
}: {
  qboInvoiceId: string
  methods: PaymentMethod[]
  preferredPaymentType: "email" | "ach" | "credit_card" | "card" | null
  routeUnresolved?: string | null
  disabled?: boolean
  invoiceBalance?: number | null
}) {
  const preferred = normalize(preferredPaymentType)
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active = methods
    .filter((m) => m.is_active !== false)
    .sort((a, b) => {
      const ad0 = a.is_default ? 0 : 1
      const bd0 = b.is_default ? 0 : 1
      if (ad0 !== bd0) return ad0 - bd0
      return (b.qbo_created_at ?? "").localeCompare(a.qbo_created_at ?? "")
    })

  const selected = (() => {
    if (preferred) {
      const match = active.find((m) => normalize(m.type) === preferred)
      if (match) return match
    }
    return active.find((m) => m.is_default) ?? active[0] ?? null
  })()

  const isEmailRoute = preferredPaymentType === "email" || !selected

  async function post(url: string, body: unknown, key: string) {
    setBusy(key)
    setError(null)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: "failed" }))
        throw new Error(msg || `${res.status}`)
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed")
    } finally {
      setBusy(null)
    }
  }

  const switchTo = (t: Channel | null) =>
    post(`/api/billing/invoices/${qboInvoiceId}/preferred-payment-type`, { type: t }, "switch")

  const chargeBalance = (pmId: string, channel: Channel) => {
    if (
      !confirm(
        `Charge ${formatCurrency(invoiceBalance ?? 0)} to this method? ` +
          `This creates a new processing attempt and posts a QBO Payment when the charge clears.`,
      )
    )
      return
    return post(
      `/api/billing/invoices/${qboInvoiceId}/charge-balance`,
      { target_payment_method_id: pmId, channel },
      `charge:${pmId}`,
    )
  }

  const canChargeBalance = disabled && invoiceBalance != null && invoiceBalance > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment method</CardTitle>
        <div className="ml-auto flex items-center gap-1.5">
          {routeUnresolved && (
            <span
              className="inline-flex items-center rounded-full border border-coral/40 bg-coral/[0.08] px-2 py-0.5 text-[10px] text-coral"
              title={`Route is ${routeUnresolved} but no matching method is on file — blocking processing`}
            >
              no {routeUnresolved} method
            </span>
          )}
          {active.length > 1 && (
            <span
              className="text-[10px] text-ink-mute border border-line-soft rounded-full px-1.5 py-px"
              title={`${active.length} methods on file`}
            >
              {active.length}
            </span>
          )}
          {active.length > 0 && !disabled && (
            <button
              onClick={() => setOpen(!open)}
              className="text-ink-mute hover:text-ink"
              title={open ? "Close" : "Choose a different method"}
            >
              {open ? (
                <X className="w-3.5 h-3.5" strokeWidth={2} />
              ) : (
                <Pencil className="w-3.5 h-3.5" strokeWidth={2} />
              )}
            </button>
          )}
        </div>
      </CardHeader>
      <CardBody className="text-sm">
        {/* the current method — the only thing shown by default */}
        {isEmailRoute ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex w-9 h-6 rounded items-center justify-center bg-bg-elev border border-line-soft">
              <Mail className="w-3.5 h-3.5 text-ink-dim" strokeWidth={2} />
            </span>
            <div className="text-[13px] text-ink">
              Email invoice
              <div className="text-[11px] text-ink-mute">
                {active.length === 0
                  ? "no card or ACH on file"
                  : "customer pays the emailed invoice"}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <BrandIcon brand={selected!.card_brand} type={selected!.type} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink truncate">
                {normalize(selected!.type) === "ach"
                  ? "Bank account"
                  : (selected!.card_brand ?? "Card")}{" "}
                <span className="font-mono text-ink-dim">···{selected!.last_four ?? "—"}</span>
              </div>
              <div className="text-[11px] text-ink-mute">
                {disabled ? "charged" : "will charge"}
                {preferred && normalize(selected!.type) === preferred && " · override"}
              </div>
            </div>
            {!disabled && <Pill tone="cyan" dot className="text-[10px]">active</Pill>}
          </div>
        )}

        {/* anchored picker — every method on file as a selectable item card */}
        {open && (
          <div className="mt-3 pt-2 border-t border-line-soft">
            <ItemGroup>
              {active.map((m) => {
                const ch = normalize(m.type)
                const isSelected = selected?.id === m.id
                const canSwitch = !disabled && !isSelected && ch != null && busy === null
                return (
                  <Item
                    key={m.id}
                    variant={isSelected ? "outline" : "muted"}
                    size="xs"
                    onClick={canSwitch ? () => switchTo(ch) : undefined}
                    className={`${isSelected ? "border-cyan/40 bg-cyan/[0.06]" : ""} ${
                      canSwitch ? "cursor-pointer hover:border-line" : ""
                    }`}
                  >
                    <ItemMedia>
                      <BrandIcon brand={m.card_brand} type={m.type} />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {ch === "ach" ? "Bank account" : (m.card_brand ?? "Card")}
                        <span className="font-mono text-ink-dim">···{m.last_four ?? "—"}</span>
                      </ItemTitle>
                      <ItemDescription>
                        added {m.qbo_created_at ? formatDate(m.qbo_created_at) : "—"}
                        {m.is_default ? " · QBO default" : ""}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {canChargeBalance && ch ? (
                        <button
                          onClick={() => chargeBalance(m.id, ch)}
                          disabled={busy !== null}
                          className="text-[11px] text-cyan border border-cyan/40 bg-cyan/10 rounded-md px-2 py-0.5 hover:bg-cyan/20 disabled:opacity-50"
                        >
                          {busy === `charge:${m.id}`
                            ? "Charging…"
                            : `Charge ${formatCurrency(invoiceBalance ?? 0)}`}
                        </button>
                      ) : isSelected ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-cyan">
                          <Check className="w-3 h-3" strokeWidth={2.5} /> selected
                        </span>
                      ) : (
                        <span className="text-[11px] text-cyan">use</span>
                      )}
                    </ItemActions>
                  </Item>
                )
              })}
            </ItemGroup>
            {preferred && !disabled && (
              <button
                onClick={() => switchTo(null)}
                disabled={busy !== null}
                className="text-[11px] text-ink-mute hover:text-ink px-1 pt-2"
                title="Clear the per-invoice override and fall back to the QBO default"
              >
                reset to default
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 text-[11px] text-coral bg-coral/[0.06] border border-coral/30 rounded px-2.5 py-1.5">
            {error}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
