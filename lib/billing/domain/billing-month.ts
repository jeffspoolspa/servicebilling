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
 *   I-B3 THE DOCUMENT IS THE FREEZE  the claim ledger is free to change
 *                      until the invoice is CREATED — the billing checks are
 *                      where a bad consumable surfaces, and fixing it means
 *                      editing visits, so freezing at month end would make
 *                      the checks unactionable. Once the document exists it
 *                      may still be edited (until it is sent), but every such
 *                      edit goes through as a VARIANCE: it bridges the
 *                      difference between what we claimed and what we billed,
 *                      and it forces a reason. Silence is what we are
 *                      refusing, not change.
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

/**
 * A difference between what the ledger claimed and what the document bills,
 * recorded on purpose. Kinds are the model doc's; a reason is mandatory,
 * because an unexplained edit to a customer's bill is the thing this exists
 * to prevent.
 */
export type VarianceKind = "remove_consumable" | "qty_correction" | "discount" | "missed"

export interface Variance {
  readonly visitId: string | null
  readonly kind: VarianceKind
  /**
   * WHICH SIDE MOVED. A variance bridges a difference, and the two sides
   * produce different work: something added to a visit after the freeze means
   * the document is now short, and an edit to the document means ION's log
   * still shows what we no longer bill.
   */
  readonly origin: "visit" | "invoice"
  readonly reason: string
  readonly deltaCents: number | null
  /** Who it is attributed to — a tech, when the difference is theirs. */
  readonly techId: string | null
  /**
   * What was POSSIBLE when it was recorded — `amend_invoice` if the document
   * was still a draft, `recorded_only` if the customer already had it.
   *
   * This is history, not a live answer: whether a difference can be pushed
   * through TODAY depends on the month's current state (see
   * pendingAmendments), because a send closes the door on differences
   * recorded before it too. Kept because it is a real operational signal —
   * an `amend_invoice` variance that is no longer pending is one we could
   * have fixed and let go out anyway.
   */
  readonly disposition: "amend_invoice" | "recorded_only"
  readonly at: string
}

export interface BillingMonthFact {
  readonly type: "VisitClaimed" | "VisitReleased" | "MonthInvoiced" | "VarianceRecorded" | "MonthSent"
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
    /** When the document was created — the ledger's freeze. [I-B3] */
    private invoicedAt: string | null,
    /** When the customer got it. */
    private sentAt: string | null,
    private readonly variances: Variance[] = [],
  ) {}

  static open(id: string, customerId: number, month: string): BillingMonth {
    if (!/^\d{4}-\d{2}-01$/.test(month)) {
      throw new BillingRuleError(`a billing month is the first of a month, got "${month}"`)
    }
    return new BillingMonth(id, customerId, month, new Map(), null, null)
  }

  static reconstitute(
    id: string,
    customerId: number,
    month: string,
    claims: readonly Claim[],
    invoicedAt: string | null,
    sentAt: string | null = null,
    variances: readonly Variance[] = [],
  ): BillingMonth {
    return new BillingMonth(
      id, customerId, month,
      new Map(claims.map((c) => [c.visitId, c])),
      invoicedAt, sentAt, [...variances],
    )
  }

  /** The document exists — the claim ledger is closed from here. [I-B3] */
  get isInvoiced(): boolean {
    return this.invoicedAt !== null
  }

  /** The customer has it. Editing stops; a change is now a credit, not an edit. */
  get isSent(): boolean {
    return this.sentAt !== null
  }

  get recordedVariances(): readonly Variance[] {
    return [...this.variances]
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
    if (this.isInvoiced) {
      throw new BillingRuleError(
        `${this.month} was invoiced ${this.invoicedAt} — the ledger is closed; record a Variance for ${v.visitId} instead [I-B3]`,
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
    if (this.isInvoiced) {
      throw new BillingRuleError(`${this.month} was invoiced — record a Variance for ${visitId} instead [I-B3]`)
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
   * The document now exists. THIS is the ledger's freeze — everything before
   * it is reversible without explanation; everything after it is a Variance.
   */
  markInvoiced(delivered: readonly BillableVisit[], now: Date, at: string): void {
    if (this.isInvoiced) return
    const blockers = [...this.issueBlockers(now), ...this.completenessBlockers(delivered)]
    if (blockers.length > 0) {
      throw new BillingRuleError(`${this.month} cannot be invoiced: ${blockers.join("; ")}`)
    }
    this.invoicedAt = at
    this.facts.push({
      type: "MonthInvoiced",
      monthId: this.id,
      at,
      payload: { customerId: this.customerId, month: this.month, claims: this.claimed.size },
    })
  }

  /**
   * Bridge a difference between what we claimed and what the document bills.
   *
   * This is the ONLY way past the freeze, and it is deliberately not free:
   * a reason is required, and the difference is attributable. An edit made in
   * QBO that never becomes a Variance is a silent divergence, which is the
   * failure this whole rule exists to make impossible.
   */
  recordVariance(v: Omit<Variance, "at" | "disposition">, at: string): void {
    if (!this.isInvoiced) {
      throw new BillingRuleError(`${this.month} has no invoice yet — change the claim itself, not a Variance`)
    }
    if (!v.reason.trim()) {
      throw new BillingRuleError("a variance needs a reason — an unexplained change to a customer's bill is what this refuses")
    }
    if (v.visitId && !this.claimed.has(v.visitId)) {
      throw new BillingRuleError(`visit ${v.visitId} is not claimed by ${this.month} — a variance can only bridge what we billed`)
    }
    // Before the send, the difference can still change the bill; after it,
    // the bill is what the customer read and only the record can change.
    const disposition = this.isSent ? ("recorded_only" as const) : ("amend_invoice" as const)
    this.variances.push({ ...v, disposition, at })
    this.facts.push({
      type: "VarianceRecorded",
      monthId: this.id,
      at,
      payload: { ...v, disposition, month: this.month, customerId: this.customerId },
    })
  }

  /** The customer has it. After this an edit is a credit, not a variance. */
  markSent(at: string): void {
    if (!this.isInvoiced) throw new BillingRuleError(`${this.month} has no invoice to send`)
    if (this.isSent) return
    this.sentAt = at
    this.facts.push({
      type: "MonthSent",
      monthId: this.id,
      at,
      payload: { customerId: this.customerId, month: this.month, variances: this.variances.length },
    })
  }

  /** What the document bills over what the ledger claimed, in cents. */
  get varianceTotalCents(): number {
    return this.variances.reduce((sum, v) => sum + (v.deltaCents ?? 0), 0)
  }

  /**
   * Variances that can still be pushed through, and what each one needs.
   *
   * An INVOICE-side edit leaves ION's log still showing what we no longer
   * bill, so the log needs the matching edit (the model doc's
   * requiresIonEdit split). A VISIT-side change leaves the document short,
   * so the document needs a line.
   *
   * Once the month is SENT this list is empty — not because the differences
   * stopped mattering, but because the answer to them is now a credit rather
   * than an amendment. That is true even of differences recorded while the
   * document was still a draft: the send closes the door on all of them.
   */
  pendingAmendments(): { variance: Variance; needs: "ion_log_edit" | "invoice_line" }[] {
    if (this.isSent) return []
    return this.variances
      .filter((v) => v.disposition === "amend_invoice")
      .map((v) => ({
        variance: v,
        needs: v.origin === "invoice" ? ("ion_log_edit" as const) : ("invoice_line" as const),
      }))
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
