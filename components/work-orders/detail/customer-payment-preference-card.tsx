"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Mail, CreditCard, Building2 } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Customer-level payment preference card.
 *
 * Lives in the WO detail right sidebar so when a card declines (or otherwise
 * needs review) you can flip the entire customer to a different channel
 * without bouncing to the customer detail page. Common case: card on file
 * was rejected, customer says "actually just email me invoices going
 * forward" — one click here sets the customer-level pref AND optionally
 * cascades to all their needs_review invoices.
 *
 * Cascade rules (server-enforced in set_customer_preferred_payment_type):
 *   - Only flips invoices in billing_status='needs_review'
 *   - Skips invoices with preferred_payment_type_overridden_at NOT NULL
 *     (someone clicked the per-invoice override — that intent wins)
 *   - awaiting_pre_processing rows naturally inherit on next pre_process
 *     so we don't touch them here
 *   - ready_to_process rows are intentional / about to fire — also untouched
 */

type Channel = "email" | "ach" | "credit_card"

const CHANNELS: Array<{ value: Channel; label: string; Icon: typeof Mail }> = [
  { value: "email", label: "Email", Icon: Mail },
  { value: "credit_card", label: "Credit Card", Icon: CreditCard },
  { value: "ach", label: "ACH", Icon: Building2 },
]

export function CustomerPaymentPreferenceCard({
  qboCustomerId,
  customerName,
  currentPreference,
  needsReviewCount,
  needsReviewOverriddenCount,
}: {
  qboCustomerId: string
  customerName: string | null
  currentPreference: Channel | null
  /** Count of invoices for this customer in billing_status='needs_review'
   *  with no per-invoice override — these are the candidates for cascade. */
  needsReviewCount: number
  /** Count of needs_review invoices that DO have an override and would be
   *  skipped by the cascade. Surface this so the user knows what won't change. */
  needsReviewOverriddenCount: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Channel | null>(currentPreference)
  const [applyToNeedsReview, setApplyToNeedsReview] = useState(true)

  const dirty = selected !== currentPreference
  const cascadeWillFire = applyToNeedsReview && dirty && needsReviewCount > 0

  async function save() {
    setError(null)
    startTransition(async () => {
      const res = await fetch(`/api/customers/${qboCustomerId}/preferred-payment-type`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selected,
          applyToNeedsReview,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="justify-between">
        <CardTitle>Customer payment preference</CardTitle>
        {currentPreference ? (
          <Pill tone="cyan">{labelFor(currentPreference)}</Pill>
        ) : (
          <Pill tone="neutral">auto</Pill>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="text-[11px] text-ink-mute">
          Sets the default for {customerName ?? "this customer"}'s future invoices.
          {currentPreference === null && (
            <> Currently auto-derived from default payment method on file.</>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {CHANNELS.map(({ value, label, Icon }) => {
            const active = selected === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => setSelected(active ? null : value)}
                disabled={pending}
                className={cn(
                  "flex flex-col items-center gap-1 px-2 py-2 rounded-md border text-[11px] transition-colors",
                  active
                    ? "bg-cyan/10 border-cyan/40 text-cyan"
                    : "bg-white/[0.02] border-line text-ink-dim hover:border-line-soft hover:text-ink",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
                {label}
              </button>
            )
          })}
        </div>

        <label className="flex items-start gap-2 text-[11px] text-ink-dim cursor-pointer select-none">
          <input
            type="checkbox"
            checked={applyToNeedsReview}
            onChange={(e) => setApplyToNeedsReview(e.target.checked)}
            disabled={pending}
            className="mt-0.5"
          />
          <span>
            Apply to {needsReviewCount} needs-review invoice
            {needsReviewCount === 1 ? "" : "s"} for this customer
            {needsReviewOverriddenCount > 0 && (
              <span className="text-ink-mute">
                {" "}
                ({needsReviewOverriddenCount} with manual overrides will be
                skipped)
              </span>
            )}
          </span>
        </label>

        {error && (
          <div className="text-[11px] text-coral border border-coral/20 bg-coral/5 rounded px-2 py-1.5">
            {error}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={pending || !dirty}
            className={cn(
              "px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
              dirty
                ? "bg-cyan text-bg hover:bg-cyan/90"
                : "bg-white/5 text-ink-mute cursor-not-allowed",
              "disabled:opacity-50",
            )}
          >
            {pending
              ? "Saving…"
              : cascadeWillFire
                ? `Save & update ${needsReviewCount} invoice${needsReviewCount === 1 ? "" : "s"}`
                : "Save"}
          </button>
        </div>
      </CardBody>
    </Card>
  )
}

function labelFor(c: Channel): string {
  if (c === "email") return "Email"
  if (c === "credit_card") return "Credit Card"
  return "ACH"
}
