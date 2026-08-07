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
 * It owns the CLAIM LEDGER: which sources this month has taken responsibility
 * for. Three invariants live here:
 *
 *   I-B1 EXCLUSIVITY   a source is claimed by at most one month. Double-claim
 *                      is how a customer gets billed twice for one visit.
 *   I-B2 COMPLETENESS  every billable source is claimed before the month can
 *                      move on. Evaluated as a QUERY, not thrown — a month
 *                      passes through incomplete states while it is built.
 *   I-B3 THE DOCUMENT IS THE FREEZE  the ledger changes freely until the
 *                      invoice is CREATED — the billing checks are where a
 *                      bad consumable surfaces, and fixing it means editing
 *                      visits, so freezing at month end would make the checks
 *                      unactionable. After creation every difference, from
 *                      EITHER side, goes through as a VARIANCE that bridges
 *                      the gap and forces a reason. Silence is what this
 *                      refuses, not change.
 *
 * Billing DERIVES billability from Delivery's facts; it never re-decides what
 * happened at the pool. Delivery states, Billing judges.
 */

import { isBillable, sourceKeyOf, type BillableItem, type BillableSource } from "./billable-item"

export class BillingRuleError extends Error {}

/* -------------------------------- variance -------------------------------- */

export type VarianceKind =
  | "remove_consumable"
  | "qty_correction"
  | "discount"
  | "missed"
  /**
   * A flat rate billed in full for a month only partly served. The ledger
   * states the contract; this states the adjustment — separately, so it can
   * be seen, explained and totalled, rather than disappearing into a smaller
   * number nobody can trace back.
   */
  | "proration"

export interface Variance {
  readonly sourceId: string | null
  readonly kind: VarianceKind
  /**
   * WHICH SIDE MOVED. The two produce different work: something added to a
   * visit after the freeze leaves the document short; an edit to the document
   * leaves ION's log showing what we no longer bill.
   */
  readonly origin: "visit" | "invoice"
  readonly reason: string
  readonly deltaCents: number | null
  readonly techId: string | null
  /**
   * What was POSSIBLE when it was recorded. History, not a live answer:
   * whether a difference can still be pushed through depends on the month's
   * CURRENT state (see pendingAmendments), because a send closes the door on
   * differences recorded before it too. Kept because an `amend_invoice`
   * variance that is no longer pending is a real signal — one we could have
   * fixed and let go out anyway.
   */
  readonly disposition: "amend_invoice" | "recorded_only"
  readonly at: string
}

export interface BillingMonthFact {
  readonly type:
    | "SourceClaimed"
    | "SourceReleased"
    | "MonthReconciled"
    | "MonthDisputed"
    | "DeliveryRefreshed"
    | "MonthGated"
    | "MonthInvoiced"
    | "MonthPreprocessed"
    | "VarianceRecorded"
    | "MonthSent"
    | "MonthServiceEnded"
  readonly monthId: string
  readonly at: string
  readonly payload: Record<string, unknown>
}

/** Where the month is. Derived from what has happened, never stamped. */
export type MonthStatus = "accruing" | "disputed" | "reconciled" | "held" | "gated" | "invoiced"

/** The next COMMAND this month is owed. Null = nothing to do, or a human's turn. */
export type NextStep = "accrue" | "reconcile" | "refresh_delivery" | "gate" | "issue" | null

export class BillingMonth {
  private facts: BillingMonthFact[] = []
  /** Did the ITEM SET change since reconstitution? A no-op re-accrue must
   *  not cost a delete+reinsert of every row. */
  private itemsDirty = false

  private constructor(
    readonly id: string,
    readonly customerId: number,
    /** First day of the month, ISO. The month IS the period. */
    readonly month: string,
    private readonly items: Map<string, BillableItem>,
    private reconciledAt: string | null,
    private disputedAt: string | null,
    private disputes: string[],
    private deliveryRefreshedAt: string | null,
    private gatedAt: string | null,
    private gateHeldFor: string[],
    private invoicedAt: string | null,
    private readonly variances: Variance[],
    private serviceEndedAt: string | null,
  ) {}

  static open(id: string, customerId: number, month: string): BillingMonth {
    if (!/^\d{4}-\d{2}-01$/.test(month)) {
      throw new BillingRuleError(`a billing month is the first of a month, got "${month}"`)
    }
    return new BillingMonth(id, customerId, month, new Map(), null, null, [], null, null, [], null, [], null)
  }

  static reconstitute(args: {
    id: string
    customerId: number
    month: string
    items?: readonly BillableItem[]
    reconciledAt?: string | null
    disputedAt?: string | null
    disputes?: readonly string[]
    deliveryRefreshedAt?: string | null
    gatedAt?: string | null
    gateHeldFor?: readonly string[]
    invoicedAt?: string | null
    variances?: readonly Variance[]
    serviceEndedAt?: string | null
  }): BillingMonth {
    return new BillingMonth(
      args.id,
      args.customerId,
      args.month,
      new Map((args.items ?? []).map((i) => [sourceKeyOf(i), i])),
      args.reconciledAt ?? null,
      args.disputedAt ?? null,
      [...(args.disputes ?? [])],
      args.deliveryRefreshedAt ?? null,
      args.gatedAt ?? null,
      [...(args.gateHeldFor ?? [])],
      args.invoicedAt ?? null,
      [...(args.variances ?? [])],
      args.serviceEndedAt ?? null,
    )
  }

  /* ------------------------------- the state ------------------------------- */

  get isInvoiced(): boolean {
    return this.invoicedAt !== null
  }

  get status(): MonthStatus {
    if (this.invoicedAt) return "invoiced"
    if (this.gateHeldFor.length > 0) return "held"
    if (this.gatedAt) return "gated"
    if (this.disputedAt) return "disputed"
    if (this.reconciledAt) return "reconciled"
    return "accruing"
  }

  get billableItems(): readonly BillableItem[] {
    return [...this.items.values()]
  }

  get recordedVariances(): readonly Variance[] {
    return [...this.variances]
  }

  get heldFor(): readonly string[] {
    return [...this.gateHeldFor]
  }

  /** What the month bills before variances, in cents. */
  get subtotalCents(): number {
    return this.billableItems.reduce((sum, i) => sum + i.amountCents, 0)
  }

  /* -------------------------------- claiming ------------------------------- */

  /**
   * Take responsibility for a priced source. [I-B1, I-B3]
   *
   * Claiming the same source twice into THIS month is a no-op, not an error —
   * a re-run of accrual must converge, not explode.
   */
  claim(item: BillableItem, source: Pick<BillableSource, "claimedByMonthId">, at: string): void {
    const key = sourceKeyOf(item)
    if (this.isInvoiced) {
      throw new BillingRuleError(
        `${this.month} was invoiced ${this.invoicedAt} — the ledger is closed; record a Variance for ${key} instead [I-B3]`,
      )
    }
    if (!item.serviceDate.startsWith(this.month.slice(0, 7))) {
      throw new BillingRuleError(`${key} fell on ${item.serviceDate}, which is not in ${this.month.slice(0, 7)}`)
    }
    if (source.claimedByMonthId && source.claimedByMonthId !== this.id) {
      throw new BillingRuleError(`${key} is already claimed by month ${source.claimedByMonthId} [I-B1]`)
    }
    const existing = this.items.get(key)
    if (existing && existing.amountCents === item.amountCents && existing.qty === item.qty) return

    // A person's non-billable mark SURVIVES re-pricing — accrual restates
    // the observation, never the decision.
    this.items.set(key, existing?.excludedAt ? { ...item, excludedAt: existing.excludedAt, excludedBy: existing.excludedBy ?? null } : item)
    this.itemsDirty = true
    // The sums moved, so any agreement we had with the system of record is
    // stale — a month cannot stay "reconciled" through a change.
    this.unreconcile()
    // Re-pricing before the freeze is legitimate and silent; that is what
    // "reversible while drafts" means.
    if (!existing) {
      this.facts.push({
        type: "SourceClaimed",
        monthId: this.id,
        at,
        payload: { ...item, customerId: this.customerId, month: this.month },
      })
    }
  }

  /** Give a source back. Legal right up until the invoice exists. [I-B3] */
  release(sourceKind: BillableItem["sourceKind"], sourceId: string, at: string, reason: string): void {
    const existing = [...this.items.values()].find((i) => i.sourceKind === sourceKind && i.sourceId === sourceId)
    if (existing?.qboInvoiceId) {
      throw new BillingRuleError(
        `${sourceKind}:${sourceId} is locked by invoice ${existing.qboInvoiceId} — items on an issued invoice do not change`,
      )
    }
    const key = sourceKeyOf({ sourceKind, sourceId })
    if (this.isInvoiced) {
      throw new BillingRuleError(`${this.month} was invoiced — record a Variance for ${key} instead [I-B3]`)
    }
    if (!this.items.delete(key)) return
    this.itemsDirty = true
    this.unreconcile()
    this.facts.push({ type: "SourceReleased", monthId: this.id, at, payload: { key, reason } })
  }

  /* ------------------------------ the questions ---------------------------- */

  /** I-B2 as a QUERY. A month under construction is legal, not broken. */
  unclaimed(delivered: readonly BillableSource[]): BillableSource[] {
    return delivered.filter(
      (s) =>
        isBillable(s) &&
        s.serviceDate.startsWith(this.month.slice(0, 7)) &&
        !this.items.has(sourceKeyOf(s)) &&
        (!s.claimedByMonthId || s.claimedByMonthId === this.id),
    )
  }

  completenessBlockers(delivered: readonly BillableSource[]): string[] {
    const missing = this.unclaimed(delivered)
    return missing.length === 0
      ? []
      : [`${missing.length} billable source(s) unclaimed [I-B2]: ${missing.slice(0, 3).map((s) => `${s.itemName} ${s.serviceDate}`).join(", ")}`]
  }

  /** The first day this month can be billed: the first of the NEXT month. */
  get billableFrom(): string {
    const [y, m] = this.month.split("-").map(Number)
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  }

  monthIsOver(now: Date): boolean {
    // RULED 2026-08-07: the period follows the SERVICE — a cancellation
    // ends it early, and the month is billable from that moment. The
    // calendar month-end is just the default close. Reconcile freshness is
    // untouched: issuance still rides the same ladder.
    if (this.serviceEndedAt) return true
    return now.toISOString().slice(0, 10) >= this.billableFrom
  }

  get serviceEnded(): string | null {
    return this.serviceEndedAt
  }

  /** Service ended mid-month (cancellation) — close the period NOW. The
   *  sums moved out from under any prior verdicts, so reconcile and the
   *  gate re-run; issuance then passes the date check on this fact. */
  endService(at: string, reason: string): void {
    if (this.isInvoiced) throw new BillingRuleError(`${this.month} is already invoiced`)
    if (this.serviceEndedAt) return // idempotent — replay-safe
    this.serviceEndedAt = at
    this.unreconcile()
    this.facts.push({ type: "MonthServiceEnded", monthId: this.id, at, payload: { reason, endedAt: at } })
  }

  /**
   * Why this month may not be invoiced yet — empty means it may. Reasons
   * rather than a throw, because a month waiting on the calendar is a normal
   * state the UI should explain.
   */
  issueBlockers(now: Date): string[] {
    const blockers: string[] = []
    if (!this.monthIsOver(now)) {
      blockers.push(
        `${this.month.slice(0, 7)} is not over — billable from ${this.billableFrom}, today is ${now.toISOString().slice(0, 10)}`,
      )
    }
    if (this.items.size === 0) blockers.push("nothing claimed — an empty month is not an invoice")
    if (this.gateHeldFor.length > 0) blockers.push(`held by the gate: ${this.gateHeldFor.join(", ")}`)
    return blockers
  }

  /**
   * The next command this month is owed — the SINGLE statement of the
   * sequence, so the loop and the tail-chain can never disagree.
   *
   * Null means nothing to do OR a human's turn: a held month waits for a
   * person, and a month whose calendar has not arrived waits for the clock.
   * Accrual and reconciliation are available mid-month on purpose; only
   * issuing waits for the month to end.
   */
  nextStep(delivered: readonly BillableSource[], now: Date): NextStep {
    // RULED: the month's own lifecycle ENDS at invoice creation. After it,
    // each invoice runs its OWN machine (enrich folded into creation ->
    // credit check -> charge -> send), and the month merely TRACKS: it is
    // CLOSED when every linked invoice is sent and paid — a fold the read
    // model derives, never a command the month is owed.
    if (this.isInvoiced) return null
    // COMPLETENESS OUTRANKS THE HOLD (RULED 2026-08-07): a gate verdict on
    // a ledger that no longer reflects delivery is worthless — an unclaimed
    // source (e.g. a re-ingested log with new source ids) re-accrues FIRST;
    // the claim un-reconciles and clears the hold, and the ladder then
    // re-runs reconcile and a FRESH gate.
    if (this.completenessBlockers(delivered).length > 0) return "accrue"
    // A hold is a SNAPSHOT of gate facts — a person changes those facts by
    // resolving findings, so a held month's step is to RE-ASK the gate
    // (RULED: the gate re-computes until invoiced). The advance service
    // stops the chain when a re-ask leaves the month still held.
    if (this.gateHeldFor.length > 0) return "gate"
    // A dispute buys ONE trip back to the system of record; a second one is
    // a real issue for a person, not something to retry forever.
    if (this.disputedAt) return this.deliveryRefreshedAt ? null : "refresh_delivery"
    // While the period is OPEN, accrual is the only step owed: ION's
    // invoices for the month do not exist yet, so a reconcile would dispute
    // against nothing and burn a delivery refresh per night. The nightly
    // audit still flags visits regardless of steps. (Phase 2 — the ION
    // rebuilt-invoice checksum — is what moves reconcile earlier.)
    if (!this.monthIsOver(now)) return null
    if (!this.reconciledAt) return "reconcile"
    if (!this.gatedAt) return "gate"
    return this.issueBlockers(now).length === 0 ? "issue" : null
  }

  /* ------------------------------ the transitions --------------------------- */

  /** Our sums agreed with the system of record, per task. */
  markReconciled(at: string): void {
    if (this.isInvoiced) throw new BillingRuleError(`${this.month} is already invoiced`)
    this.disputedAt = null
    this.disputes = []
    this.reconciledAt = at
    this.facts.push({ type: "MonthReconciled", monthId: this.id, at, payload: { items: this.items.size, subtotalCents: this.subtotalCents } })
  }

  /** A change after reconciliation invalidates it — the sums moved. */
  private unreconcile(): void {
    this.reconciledAt = null
    this.disputedAt = null
    this.disputes = []
    this.gatedAt = null
    this.gateHeldFor = []
  }

  get disputeReasons(): readonly string[] {
    return [...this.disputes]
  }

  /**
   * Our sums did NOT agree. Not an error and not yet a person's problem: the
   * usual cause is that our copy of delivery is stale — ION deletes a log or
   * a tech adds a chemical after we last read it. So the first answer is to
   * go and look again, ONCE, and only a second disagreement is a real issue.
   */
  markDisputed(reasons: readonly string[], at: string): void {
    if (this.isInvoiced) throw new BillingRuleError(`${this.month} is already invoiced`)
    this.reconciledAt = null
    this.disputedAt = at
    this.disputes = [...reasons]
    this.facts.push({ type: "MonthDisputed", monthId: this.id, at, payload: { reasons: this.disputes, refreshed: this.deliveryRefreshedAt !== null } })
  }

  /**
   * We went back to the system of record for this month's tasks. Marked so it
   * happens at most once per dispute cycle — a repull that does not resolve
   * the difference must surface, not loop.
   */
  markDeliveryRefreshed(at: string): void {
    this.deliveryRefreshedAt = at
    this.disputedAt = null
    this.disputes = []
    this.facts.push({ type: "DeliveryRefreshed", monthId: this.id, at, payload: { month: this.month, customerId: this.customerId } })
  }

  /** Has the one automatic repull already been spent? */
  get deliveryWasRefreshed(): boolean {
    return this.deliveryRefreshedAt !== null
  }

  /**
   * The check set ran. `heldFor` is the named criteria that failed — empty
   * means cleared. Recorded either way, because "why was this held" is a
   * question someone asks weeks later.
   */
  markGated(heldFor: readonly string[], at: string): void {
    if (this.isInvoiced) throw new BillingRuleError(`${this.month} is already invoiced`)
    if (!this.reconciledAt) throw new BillingRuleError(`${this.month} has not been reconciled — gate it after, not before`)
    this.gatedAt = at
    this.gateHeldFor = [...heldFor]
    this.facts.push({
      type: "MonthGated",
      monthId: this.id,
      at,
      payload: { cleared: this.gateHeldFor.length === 0, heldFor: this.gateHeldFor },
    })
  }

  /** A person resolved what the gate held it for; it may be re-gated. */
  clearHold(at: string, by: string): void {
    if (this.gateHeldFor.length === 0) return
    this.facts.push({ type: "MonthGated", monthId: this.id, at, payload: { cleared: true, by, wasHeldFor: this.gateHeldFor } })
    this.gateHeldFor = []
    this.gatedAt = null
  }

  /**
   * The document now exists. THIS is the ledger's freeze — everything before
   * it is reversible without explanation; everything after it is a Variance.
   */
  markInvoiced(delivered: readonly BillableSource[], now: Date, at: string): void {
    if (this.isInvoiced) return
    const blockers = [...this.issueBlockers(now), ...this.completenessBlockers(delivered)]
    if (blockers.length > 0) throw new BillingRuleError(`${this.month} cannot be invoiced: ${blockers.join("; ")}`)
    this.invoicedAt = at
    this.facts.push({
      type: "MonthInvoiced",
      monthId: this.id,
      at,
      payload: { customerId: this.customerId, month: this.month, items: this.items.size, subtotalCents: this.subtotalCents },
    })
  }

  /**
   * Bridge a difference between what the ledger claimed and what the document
   * bills. The ONLY way past the freeze, and deliberately not free: a reason
   * is required and the difference is attributable.
   */
  recordVariance(v: Omit<Variance, "at" | "disposition">, at: string, opts: { invoiceSent: boolean } = { invoiceSent: false }): void {
    if (!this.isInvoiced) {
      throw new BillingRuleError(`${this.month} has no invoice yet — change the claim itself, not a Variance`)
    }
    if (!v.reason.trim()) {
      throw new BillingRuleError("a variance needs a reason — an unexplained change to a customer's bill is what this refuses")
    }
    // Sent-ness now belongs to the INVOICE machine — the caller answers it
    // from the invoice fold; the month only applies the ruling: before the
    // customer reads the bill, an edit amends; after, it is recorded and
    // moves as a credit.
    const disposition = opts.invoiceSent ? ("recorded_only" as const) : ("amend_invoice" as const)
    this.variances.push({ ...v, disposition, at })
    this.facts.push({ type: "VarianceRecorded", monthId: this.id, at, payload: { ...v, disposition, month: this.month, customerId: this.customerId } })
  }



  get varianceTotalCents(): number {
    return this.variances.reduce((sum, v) => sum + (v.deltaCents ?? 0), 0)
  }

  /** What the customer is actually billed, once differences are counted. */
  get totalCents(): number {
    return this.subtotalCents + this.varianceTotalCents
  }

  /**
   * Variances that can still be pushed through, and what each one needs.
   * Empty once SENT — not because the differences stopped mattering, but
   * because the answer to them is a credit rather than an amendment, and
   * that is true of differences recorded before the send as well.
   */
  pendingAmendments(): { variance: Variance; needs: "ion_log_edit" | "invoice_line" }[] {
    return this.variances
      .filter((v) => v.disposition === "amend_invoice")
      .map((v) => ({ variance: v, needs: v.origin === "invoice" ? ("ion_log_edit" as const) : ("invoice_line" as const) }))
  }

  get hasDirtyItems(): boolean {
    return this.itemsDirty
  }

  /** Facts this month recorded. Drained by whoever persists it. */
  pullFacts(): BillingMonthFact[] {
    const out = this.facts
    this.facts = []
    return out
  }
}
