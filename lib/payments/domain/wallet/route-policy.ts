import type { Wallet } from "./wallet"
import { CustomerPaymentPreference, JobBillingText, PaymentRoute } from "./values"

/**
 * How does this customer pay for this job? The four rungs, in one screen —
 * pure policy, no I/O, fully testable.
 *
 * Replaces (kill list, slice 1): billing.resolve_preferred_payment_type +
 * billing.pick_target_payment_method (frozen shims for the legacy path;
 * they die when service billing flips to the new machine). One deliberate
 * difference from the shims: an explicit charge preference with nothing
 * usable on file returns `unresolvable` for a person, where the SQL pair
 * left a NULL target for the gates to trip over.
 *
 *   1. the office wrote *bill* in the job text        → email (per-job override)
 *   2. the customer decided (preference set)           → that route
 *   3. nobody decided: the wallet has an active method → charge the default
 *   4. nothing on file                                 → email
 *
 * Rung 3 is the enrolment-by-discovery rule: vaulting a card is what opts a
 * customer into auto-charge; an explicit 'email' preference is what opts
 * them out (rung 2 beats rung 3 — Country Inn keeps its card AND its bill).
 */
export class PaymentRoutePolicy {
  resolve(job: JobBillingText, pref: CustomerPaymentPreference, wallet: Wallet): PaymentRoute {
    if (job.demandsBill()) return PaymentRoute.email()

    if (pref.isSet()) {
      if (pref.value === "email") return PaymentRoute.email()
      const instrument = wallet.defaultInstrument()
      return instrument
        ? PaymentRoute.charge(instrument)
        : PaymentRoute.unresolvable("preference is on_file but no active instrument is on file")
    }

    const instrument = wallet.defaultInstrument()
    return instrument ? PaymentRoute.charge(instrument) : PaymentRoute.email()
  }
}
