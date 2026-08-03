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
 *   I-B3 SENT IS LOCKED  the ledger freezes when the invoice is SENT, not
 *                      when the month ends and not when the document is
 *                      created. The billing checks are exactly where a bad
 *                      consumable or quantity surfaces, and fixing it means
 *                      editing visits — so an earlier freeze would make the
 *                      checks unactionable. Once the customer has it, what
 *                      they read must still read the same next year, and a
 *                      later correction becomes a Variance.
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
  readonly type: "VisitClaimed" | "VisitReleased" | "MonthSent"
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
    /** When the customer got it. Null while anything is still editable. */
    private sentAt: string | null,
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
    sentAt: string | null,
  ): BillingMonth {
    return new BillingMonth(id, customerId, month, new Map(claims.map((c) => [c.visitId, c])), sentAt)
  }

  /** Sent to the customer — the one irreversible moment. [I-B3] */
  get isSent(): boolean {
    return this.sentAt !== null
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
    if (this.isSent) {
      throw new BillingRuleError(
        `${this.month} was sent ${this.sentAt} — it cannot claim ${v.visitId}; a change now is a Variance [I-B3]`,
      )
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

  /**
   * Give a visit back. Legal right up until the invoice is sent — including
   * AFTER the document exists, because a draft is still a draft and the
   * billing checks routinely send us back to fix a visit. [I-B3]
   */
  release(visitId: string, at: string, reason: string): void {
    if (this.isSent) {
      throw new BillingRuleError(`${this.month} was sent — it cannot release ${visitId}; a change now is a Variance [I-B3]`)
    }
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

  /** Why this month is not yet complete — empty means every visit is claimed. */
  completenessBlockers(delivered: readonly BillableVisit[]): string[] {
    const blockers: string[] = []
    const missing = this.unclaimed(delivered)
    if (missing.length > 0) {
      blockers.push(`${missing.length} billable visit(s) unclaimed [I-B2]: ${missing.slice(0, 3).map((v) => v.visitDate).join(", ")}`)
    }
    if (this.claimed.size === 0) blockers.push("nothing claimed — an empty month is not a billed month")
    return blockers
  }

  /**
   * The customer now has it. THIS is the freeze — not month end, not document
   * creation. Everything before here is reversible on purpose. [I-B3]
   */
  markSent(delivered: readonly BillableVisit[], now: Date, at: string): void {
    if (this.isSent) return
    const blockers = [...this.issueBlockers(now), ...this.completenessBlockers(delivered)]
    if (blockers.length > 0) {
      throw new BillingRuleError(`${this.month} cannot be sent: ${blockers.join("; ")}`)
    }
    this.sentAt = at
    this.facts.push({
      type: "MonthSent",
      monthId: this.id,
      at,
      payload: { customerId: this.customerId, month: this.month, claims: this.claimed.size },
    })
  }

  /**
   * The first day the month can be billed: the first of the NEXT month.
   *
   * Delivery for a month is only final once the month is over. Until then an
   * invoice would be a guess that happens to look authoritative — and it is
   * the customer who would find the missing visit, not us. Running the
   * pipeline mid-month to watch progress is useful and safe; issuing from it
   * is not, so the clock is a precondition rather than a warning.
   */
  get billableFrom(): string {
    const [y, m] = this.month.split("-").map(Number)
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  }

  /** Has the month actually ended? Compared by date, never by timezone maths. */
  monthIsOver(now: Date): boolean {
    return now.toISOString().slice(0, 10) >= this.billableFrom
  }

  /**
   * Why this month may not be invoiced yet — empty means it may. The reasons
   * are returned rather than thrown because a month waiting for the calendar
   * is a normal state the UI should be able to explain, not an error.
   */
  issueBlockers(now: Date): string[] {
    const blockers: string[] = []
    if (!this.monthIsOver(now)) {
      blockers.push(`${this.month.slice(0, 7)} is not over — billable from ${this.billableFrom}, today is ${now.toISOString().slice(0, 10)}`)
    }
    if (this.claimed.size === 0) blockers.push("nothing claimed — an empty month is not an invoice")
    return blockers
  }

  /** Facts this month recorded. Drained by whoever persists it. */
  pullFacts(): BillingMonthFact[] {
    const out = this.facts
    this.facts = []
    return out
  }
}
