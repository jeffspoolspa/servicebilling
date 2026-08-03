/**
 * The billing gate — a SPECIFICATION over a MONTH, asked before any invoice
 * exists: what must be true before we ask this customer for money.
 *
 * Evans' point about specifications is the operational one: it says WHY it
 * failed, not merely that it did. Every criterion is named and a failure
 * carries a sentence, which is what lets a held month be WORKED rather than
 * wondered about — and what makes shadow comparison name the diverging rule.
 *
 * Scope note: these are the PRE-INVOICE checks. The old SQL gate
 * (invoice_gate_checks) mixed these with DOCUMENT checks — memo present,
 * class present, subtotal matches, not voided — which can only be asked once
 * a document exists. Those return at issue/send in the invoice step; putting
 * them here would hold every month on facts that cannot exist yet.
 */

import type { BillingMonth } from "./billing-month"

export interface GateCriterion {
  readonly name: string
  readonly passed: boolean
  /** Present when it failed — the sentence a person reads. */
  readonly detail?: string
}

export interface GateResult {
  readonly criteria: GateCriterion[]
  readonly cleared: boolean
  /** The names that failed — what the month is held for. */
  readonly heldFor: string[]
}

/**
 * The month's context, gathered by the caller — facts only. The gate reads,
 * it never fetches, so it stays pure and selfcheckable.
 */
export interface MonthGateFacts {
  /** QBO customer id — without a billing identity there is nobody to invoice. */
  readonly qboCustomerId: string | null
  /**
   * How this customer pays, resolved from enrollment and payment methods:
   * `autopay` = active enrollment with an active payment method;
   * `email` = a manual invoice can reach them. Null = we cannot collect.
   */
  readonly paymentRoute: "autopay" | "email" | null
  /** An unreleased hold naming this customer. Somebody said hands off. */
  readonly activeHold: string | null
  /**
   * Open maintenance credits (unapplied, recent, maintenance-marked memo)
   * with no decision. Billing more before deciding them is how a customer
   * pays twice.
   */
  readonly openCredits: { paymentId: string; unappliedCents: number }[]
  /** Unresolved blocking findings on this month — the audit's stop signs. */
  readonly blockingFindings: { rule: string; message: string }[]
}

export function gate(month: BillingMonth, facts: MonthGateFacts): GateResult {
  const criteria: GateCriterion[] = []
  const check = (name: string, passed: boolean, detail?: string) =>
    criteria.push(passed ? { name, passed } : { name, passed, detail })

  check("has_items", month.billableItems.length > 0, "nothing claimed — an empty month is not an invoice")
  check(
    "reconciled",
    month.status === "reconciled" || month.status === "gated" || month.status === "held",
    "our totals do not agree with the system of record — the gate never overrides the reconciler",
  )
  check(
    "billing_identity",
    facts.qboCustomerId !== null,
    "no QBO customer id — there is nobody to address an invoice to (is the customer still awaiting its billing identity?)",
  )
  check(
    "route_resolved",
    facts.paymentRoute !== null,
    "no payment route — not enrolled in autopay and no email on file, so a bill could not reach them",
  )
  check("not_on_hold", facts.activeHold === null, facts.activeHold ? `held: ${facts.activeHold}` : undefined)
  check(
    "credits_settled",
    facts.openCredits.length === 0,
    `${facts.openCredits.length} open credit(s) with no decision: ${facts.openCredits
      .slice(0, 3)
      .map((c) => `${c.paymentId} ($${(c.unappliedCents / 100).toFixed(2)})`)
      .join(", ")} — billing more before deciding them is how a customer pays twice`,
  )
  check(
    "findings_resolved",
    facts.blockingFindings.length === 0,
    `${facts.blockingFindings.length} unresolved blocking finding(s): ${facts.blockingFindings
      .slice(0, 3)
      .map((f) => f.rule)
      .join(", ")}`,
  )

  const heldFor = criteria.filter((c) => !c.passed).map((c) => c.name)
  return { criteria, cleared: heldFor.length === 0, heldFor }
}
