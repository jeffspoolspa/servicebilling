/**
 * The billing gate — a SPECIFICATION, not a boolean.
 *
 * This replaces `billing.invoice_gate_checks()`, which returned nine named
 * booleans from a SQL function. Two things move by bringing it here: the
 * rules become findable and testable, and the buried ones become sentences —
 * the six-month credit window and the memo pattern currently live four levels
 * deep in a `not exists`, where nobody can see them.
 *
 * Evans' point about specifications is the one that matters operationally:
 * a specification should be able to say WHY it failed, not merely that it
 * did. So this returns the named criteria, which is what lets a shadow run
 * report which rule diverged rather than "different".
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
 * Everything the gate needs to judge, gathered by the caller. Facts only:
 * the gate reads, it never fetches, so it stays pure and selfcheckable.
 */
export interface GateFacts {
  /** The document exists on the other side and is not voided. */
  readonly invoiceVoided: boolean
  /** Somebody said hands off. */
  readonly onHold: boolean
  /** Pre-processing ran — memo, class, payment route resolved. */
  readonly enriched: boolean
  readonly memo: string | null
  readonly qboClass: string | null
  /** How they pay. An unresolved route means we cannot collect. */
  readonly paymentRoute: "email" | "ach" | "credit_card" | null
  /** What the other system says the invoice totals, in cents. */
  readonly systemSubtotalCents: number | null
  /**
   * Open credits on this customer with no terminal decision against this
   * invoice. The window and the exclusions are the caller's to apply — see
   * the note in the ACL/read model, where they are spelled out.
   */
  readonly undecidedCredits: { creditId: string; unappliedCents: number }[]
  /** Our reconciliation verdict, already computed. */
  readonly reconciled: boolean
}

const SUBTOTAL_TOLERANCE_CENTS = 1

/**
 * Judge a month. Every criterion is named, and a failure carries a sentence.
 *
 * The criteria are the nine from the SQL gate, restated: what must be true
 * before a customer is asked for money.
 */
export function gate(month: BillingMonth, facts: GateFacts): GateResult {
  const criteria: GateCriterion[] = []
  const check = (name: string, passed: boolean, detail?: string) =>
    criteria.push(passed ? { name, passed } : { name, passed, detail })

  check("has_items", month.billableItems.length > 0, "nothing claimed — an empty month is not an invoice")
  check("reconciled", facts.reconciled, "our totals do not agree with the system of record, per task")
  check("not_voided", !facts.invoiceVoided, "the invoice was voided")
  check("not_on_hold", !facts.onHold, "somebody put this invoice on hold")
  check("enriched", facts.enriched, "pre-processing has not run")
  check("memo_present", facts.memo !== null && facts.memo.trim() !== "", "no memo — the customer would read a bill with no explanation")
  check("class_present", facts.qboClass !== null, "no class — the revenue would land unattributed")
  check(
    "route_resolved",
    facts.paymentRoute !== null,
    "no payment route — we do not know how this customer pays, so we cannot collect",
  )
  check(
    "subtotal_matches",
    facts.systemSubtotalCents === null || Math.abs(month.totalCents - facts.systemSubtotalCents) <= SUBTOTAL_TOLERANCE_CENTS,
    facts.systemSubtotalCents === null
      ? undefined
      : `we bill ${(month.totalCents / 100).toFixed(2)} and the document says ${(facts.systemSubtotalCents / 100).toFixed(2)}`,
  )
  check(
    "credits_settled",
    facts.undecidedCredits.length === 0,
    `${facts.undecidedCredits.length} open credit(s) with no decision against this invoice: ${facts.undecidedCredits
      .slice(0, 3)
      .map((c) => `${c.creditId} ($${(c.unappliedCents / 100).toFixed(2)})`)
      .join(", ")} — applying them after the bill goes out is how a customer pays twice`,
  )

  const heldFor = criteria.filter((c) => !c.passed).map((c) => c.name)
  return { criteria, cleared: heldFor.length === 0, heldFor }
}
