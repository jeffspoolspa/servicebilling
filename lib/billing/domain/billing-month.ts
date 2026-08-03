/**
 * BillingMonth — one customer's month of maintenance, as a consistency
 * boundary.
 *
 * RULED (2026-07-31): the conceptual unit is the CUSTOMER-month — "July pool
 * maintenance" for this customer — not the invoice. ION builds one invoice
 * per TASK, which is an implementation detail forced on us; a customer with
 * three tasks gets three invoices for one month of service, and only this
 * aggregate holds them together.
 *
 * It owns the CLAIM LEDGER: which visits this month has taken responsibility
 * for. Three invariants live here, and each throws rather than warns:
 *
 *   I-B1 EXCLUSIVITY   a visit is claimed by at most one month. Double-claim
 *                      is how a customer gets billed twice for one visit.
 *   I-B2 COMPLETENESS  every billable visit of a closed month is claimed.
 *                      Evaluated as a QUERY, not thrown — a month passes
 *                      through incomplete states while it is being built.
 *   I-B3 BILLED IS LOCKED  a locked month refuses all mutation. What was
 *                      invoiced must still read the same next year.
 *
 * Billing DERIVES billability from Delivery's facts; it never re-decides what
 * happened at the pool. Delivery states, Billing judges.
 */

export class BillingRuleError extends Error {}

/** Delivery's verdict on a visit. Billing reads this; it never writes it. */
export type VisitState = "scheduled" | "completed" | "skipped" | "non_serviceable"

/**
 * What Billing needs to know about a visit. A read model, not the Visit
 * aggregate: cross-aggregate references stay ids, so a month is reconstituted
 * with its claims, never with visit objects.
 */
export interface BillableVisit {
  readonly visitId: string
  readonly taskId: string
  readonly visitDate: string
  readonly state: VisitState
  /** Already-claimed elsewhere, per the ledger — I-B1's evidence. */
  readonly claimedByMonthId?: string | null
}

/** One visit this month has taken responsibility for. */
export interface Claim {
  readonly visitId: string
  readonly taskId: string
  readonly visitDate: string
  readonly claimedAt: string
}

export interface BillingMonthFact {
  readonly type: "VisitClaimed" | "VisitReleased" | "MonthLocked"
  readonly monthId: string
  readonly at: string
  readonly payload: Record<string, unknown>
}

/**
 * Is this visit billable? The one place the rule lives.
 *
 * A skipped or non-serviceable visit is not billable — it is a real fact
 * about the pool, not an omission. A completed visit is billable and priced
 * by the task's terms, which is why a quality-control task whose rate is zero
 * needs no special case: it bills, at nothing.
 */
export function isBillable(v: { state: VisitState }): boolean {
  return v.state === "completed"
}

export class BillingMonth {
  private facts: BillingMonthFact[] = []

  private constructor(
    readonly id: string,
    readonly customerId: number,
    /** First day of the month, ISO. The month IS the period. */
    readonly month: string,
    private readonly claimed: Map<string, Claim>,
    private lockedAt: string | null,
  ) {}

  static open(id: string, customerId: number, month: string): BillingMonth {
    if (!/^\d{4}-\d{2}-01$/.test(month)) {
      throw new BillingRuleError(`a billing month is the first of a month, got "${month}"`)
    }
    return new BillingMonth(id, customerId, month, new Map(), null)
  }

  static reconstitute(
    id: string,
    customerId: number,
    month: string,
    claims: readonly Claim[],
    lockedAt: string | null,
  ): BillingMonth {
    return new BillingMonth(id, customerId, month, new Map(claims.map((c) => [c.visitId, c])), lockedAt)
  }

  get isLocked(): boolean {
    return this.lockedAt !== null
  }

  get claims(): readonly Claim[] {
    return [...this.claimed.values()]
  }

  /**
   * Take responsibility for a visit. [I-B1, I-B3]
   *
   * Refuses a visit another month already holds, a visit that is not
   * billable, a visit from another month, and any claim at all once locked.
   * Claiming the same visit twice into THIS month is a no-op, not an error —
   * a re-run of the builder must converge, not explode.
   */
  claim(v: BillableVisit, at: string): void {
    if (this.isLocked) {
      throw new BillingRuleError(`${this.month} is locked (${this.lockedAt}) — it cannot claim ${v.visitId}`)
    }
    if (!isBillable(v)) {
      throw new BillingRuleError(`visit ${v.visitId} is ${v.state}, which is not billable`)
    }
    if (!v.visitDate.startsWith(this.month.slice(0, 7))) {
      throw new BillingRuleError(`visit ${v.visitId} fell on ${v.visitDate}, which is not in ${this.month.slice(0, 7)}`)
    }
    if (v.claimedByMonthId && v.claimedByMonthId !== this.id) {
      throw new BillingRuleError(`visit ${v.visitId} is already claimed by month ${v.claimedByMonthId} [I-B1]`)
    }
    if (this.claimed.has(v.visitId)) return

    this.claimed.set(v.visitId, { visitId: v.visitId, taskId: v.taskId, visitDate: v.visitDate, claimedAt: at })
    this.facts.push({
      type: "VisitClaimed",
      monthId: this.id,
      at,
      payload: { visitId: v.visitId, taskId: v.taskId, visitDate: v.visitDate, customerId: this.customerId },
    })
  }

  /** Give a visit back — only while the month is still open. [I-B3] */
  release(visitId: string, at: string, reason: string): void {
    if (this.isLocked) throw new BillingRuleError(`${this.month} is locked — it cannot release ${visitId}`)
    if (!this.claimed.delete(visitId)) return
    this.facts.push({ type: "VisitReleased", monthId: this.id, at, payload: { visitId, reason } })
  }

  /**
   * I-B2 as a QUERY, not a throw. A month under construction passes through
   * incomplete states legitimately; completeness is a gate asked at the
   * boundary, not an invariant enforced at every mutation.
   */
  unclaimed(delivered: readonly BillableVisit[]): BillableVisit[] {
    return delivered.filter(
      (v) =>
        isBillable(v) &&
        v.visitDate.startsWith(this.month.slice(0, 7)) &&
        !this.claimed.has(v.visitId) &&
        (!v.claimedByMonthId || v.claimedByMonthId === this.id),
    )
  }

  /** Why this month may not be locked yet — empty means it may. */
  lockBlockers(delivered: readonly BillableVisit[]): string[] {
    const blockers: string[] = []
    const missing = this.unclaimed(delivered)
    if (missing.length > 0) {
      blockers.push(`${missing.length} billable visit(s) unclaimed [I-B2]: ${missing.slice(0, 3).map((v) => v.visitDate).join(", ")}`)
    }
    if (this.claimed.size === 0) blockers.push("nothing claimed — an empty month is not a billed month")
    return blockers
  }

  /** Freeze it. After this the month is history. [I-B3] */
  lock(delivered: readonly BillableVisit[], at: string): void {
    if (this.isLocked) return
    const blockers = this.lockBlockers(delivered)
    if (blockers.length > 0) {
      throw new BillingRuleError(`${this.month} cannot lock: ${blockers.join("; ")}`)
    }
    this.lockedAt = at
    this.facts.push({
      type: "MonthLocked",
      monthId: this.id,
      at,
      payload: { customerId: this.customerId, month: this.month, claims: this.claimed.size },
    })
  }

  /** Facts this month recorded. Drained by whoever persists it. */
  pullFacts(): BillingMonthFact[] {
    const out = this.facts
    this.facts = []
    return out
  }
}
