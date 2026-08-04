import { CreditCard, Landmark, Mail } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * The house representation of a PAYMENT METHOD object: a card or bank
 * glyph with the brand and last four — "VISA x8984", "ACH x2602". Use this
 * everywhere an instrument shows (invoice lists, roster, charge history);
 * never re-spell the shape inline.
 */

export interface PaymentMethodRef {
  /** billing.customer_payment_methods.type — 'credit_card' | 'ach' (legacy 'card'/'bank' tolerated). */
  method_type?: string | null
  card_brand?: string | null
  last_four?: string | null
}

export function PaymentMethodBadge({ method, className }: { method: PaymentMethodRef | null | undefined; className?: string }) {
  // No instrument = the EMAIL route (the gate guarantees every issued
  // invoice has one or the other).
  if (!method?.last_four) {
    return (
      <span className={cn("inline-flex items-center", className)} title="email route">
        <Mail className="w-3 h-3 text-ink-mute" />
      </span>
    )
  }
  const isBank = method.method_type === "ach" || method.method_type === "bank"
  const Icon = isBank ? Landmark : CreditCard
  const brand = method.card_brand?.trim() || (isBank ? "ACH" : "CARD")
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}>
      <Icon className="w-3 h-3 text-ink-mute" />
      <span className="font-mono text-[10.5px] text-ink-dim uppercase">
        {brand} x{method.last_four}
      </span>
    </span>
  )
}
