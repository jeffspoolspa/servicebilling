/**
 * Payment-channel helpers.
 *
 * The new model stores the channel decision in `invoices.preferred_payment_type`
 * with values 'email' | 'ach' | 'credit_card'. The legacy `invoices.payment_method`
 * column ('invoice' | 'on_file') is dual-written by pre_process_invoice for the
 * duration of the rollout but will be dropped once all readers have switched
 * over. These helpers prefer the new field and fall back to the legacy mapping.
 *
 * Use `paymentChannel(row)` to get the canonical 'email' | 'ach' | 'credit_card'
 * for any row that has either field. UI components should never inspect the raw
 * column values directly — go through these helpers so the legacy field can be
 * deleted in one PR without hunting through every component.
 */

export type PaymentChannel = "email" | "ach" | "credit_card"

interface ChannelSource {
  /** processing_attempts.channel — set directly to a PaymentChannel value */
  channel?: string | null
  /** invoices.preferred_payment_type — set directly to a PaymentChannel value */
  preferred_payment_type?: string | null
  /** invoices.payment_method or processing_attempts.payment_method (legacy) */
  payment_method?: string | null
}

/**
 * Resolve the channel for a row, preferring the new field(s) and falling
 * back to the legacy mapping. Returns 'email' as a last-resort default for
 * rows with no fields set (very old historical rows).
 *
 * Looks at fields in order:
 *   1. row.channel — processing_attempts has this directly
 *   2. row.preferred_payment_type — invoices has this directly
 *   3. row.payment_method — legacy on either, derived
 */
export function paymentChannel(row: ChannelSource): PaymentChannel {
  const ch = row.channel
  if (ch === "email" || ch === "ach" || ch === "credit_card") return ch
  const pref = row.preferred_payment_type
  if (pref === "email" || pref === "ach" || pref === "credit_card") return pref
  // Legacy fallback while invoices.payment_method is still around. 'on_file'
  // doesn't tell us card-vs-ach so we pessimistically default to credit_card
  // (the dominant case) — once `target_payment_method_id` is set in the row,
  // callers can refine via that.
  if (row.payment_method === "invoice") return "email"
  if (row.payment_method === "on_file") return "credit_card"
  return "email"
}

/** True when the channel is a charge channel (ach or credit_card). */
export function isChargeChannel(row: ChannelSource): boolean {
  const ch = paymentChannel(row)
  return ch === "ach" || ch === "credit_card"
}

/** Short label: "Card", "ACH", "Email". */
export function paymentChannelShortLabel(row: ChannelSource): string {
  switch (paymentChannel(row)) {
    case "credit_card":
      return "Card"
    case "ach":
      return "ACH"
    case "email":
      return "Email"
  }
}

/** Long label used in pills and badges. */
export function paymentChannelLabel(row: ChannelSource): string {
  switch (paymentChannel(row)) {
    case "credit_card":
      return "Card on file"
    case "ach":
      return "ACH on file"
    case "email":
      return "Email only"
  }
}

/** Past-tense verb for completion messages. "charged" / "ACH'd" / "sent". */
export function paymentChannelPastTense(row: ChannelSource): string {
  switch (paymentChannel(row)) {
    case "credit_card":
      return "charged"
    case "ach":
      return "debited"
    case "email":
      return "sent"
  }
}

/** Imperative for "what would happen" copy. "Charge card" / "Debit ACH" / "Send email". */
export function paymentChannelAction(row: ChannelSource): string {
  switch (paymentChannel(row)) {
    case "credit_card":
      return "Charge card"
    case "ach":
      return "Debit ACH"
    case "email":
      return "Send email"
  }
}
