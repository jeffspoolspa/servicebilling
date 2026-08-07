import type { Instrument } from "./instrument"

/**
 * Value objects of the routing conversation — compared by contents, no
 * identity, immutable. These are the published language the route policy
 * speaks; callers construct them from whatever storage shape they hold.
 */

/** The work order's text, as billing reads it: does the office demand a
 *  bill? The token is checked across ALL free-text fields — CHESSER WO
 *  5007168 + OLSON WO 5000640 were auto-charged (2026-05-21) because *bill*
 *  sat in technician_instructions, not work_description. */
export class JobBillingText {
  private constructor(private readonly text: string) {}
  static from(...parts: (string | null | undefined)[]): JobBillingText {
    return new JobBillingText(parts.filter(Boolean).join(" "))
  }
  demandsBill(): boolean {
    return /\*bill\*/i.test(this.text)
  }
}

/** The customer-level answer to "how do I pay?" — NULL means nobody ever
 *  decided (rung 2 falls through), which is different from 'email' (an
 *  explicit opt-out that beats a wallet full of cards).
 *
 *  Two values on purpose (RULED 2026-08-06): the preference names a CHANNEL
 *  — bill me, or charge what's on file. The old 'credit_card'/'ach' vocab
 *  lied: a credit_card preference charged an ACH account when that's what
 *  existed, so kind was never really part of the decision (and zero
 *  customers hold both kinds, so no bias is lost). WHICH instrument is the
 *  wallet's question; a customer who cares names one (per-invoice override
 *  today, AutopayEnrollment-style designation if it ever matters here).
 *  Legacy stored values ('card'/'credit_card'/'ach') normalize to on_file
 *  on read — the columns keep the old vocab until cutover, because the
 *  frozen SQL gates pattern-match on it. */
export class CustomerPaymentPreference {
  private constructor(readonly value: "email" | "on_file" | null) {}
  static from(raw: string | null | undefined): CustomerPaymentPreference {
    if (raw === "card" || raw === "credit_card" || raw === "ach" || raw === "on_file")
      return new CustomerPaymentPreference("on_file")
    if (raw === "email") return new CustomerPaymentPreference("email")
    return new CustomerPaymentPreference(null)
  }
  isSet(): boolean {
    return this.value !== null
  }
}

/** The routing verdict. `unresolvable` is deliberately its own state — an
 *  explicit charge preference with nothing usable on file is a person's
 *  problem (park it), not a silent fallback to email: silence here is how
 *  an opted-IN customer quietly stops being charged. */
export type PaymentRoute =
  | { kind: "email" }
  | { kind: "charge"; instrument: Instrument }
  | { kind: "unresolvable"; reason: string }

export const PaymentRoute = {
  email(): PaymentRoute {
    return { kind: "email" }
  },
  charge(instrument: Instrument): PaymentRoute {
    return { kind: "charge", instrument }
  },
  unresolvable(reason: string): PaymentRoute {
    return { kind: "unresolvable", reason }
  },
}
