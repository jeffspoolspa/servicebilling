/**
 * Task — the maintenance contract aggregate.
 *
 * A Task is the agreement to service one pool on a cadence for a price. It is
 * the spine of the system: visits happen against it, billing accrues from it,
 * routing schedules it. Until now it had no object — its rules lived in three
 * Windmill scripts (f/ION/_lib/upsert_tasks.py, upsert_nonactive_tasks.py,
 * split_collapsed_tasks.py) as comments and inline branches, which is why the
 * same knowledge kept getting re-derived and kept drifting.
 *
 * ION is the system of record for the CONTRACT (what was agreed). We are the
 * system of record for its INTERPRETATION (what it means for money and
 * scheduling). Everything ION says arrives through `observeFromIon` — one
 * door, so the rules about trusting ION live in exactly one place.
 */

import { EffectiveHistory } from "@/lib/domain/shared/effective"
import type { Effective } from "@/lib/domain/shared/effective"

export class TaskRuleError extends Error {}

/* ───────────────────────────────────────────────────────── value objects */

export const TASK_STATUSES = ["active", "paused", "closed"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const BILLING_METHODS = ["per_visit", "flat_rate_monthly", "do_not_invoice"] as const
export type BillingMethod = (typeof BILLING_METHODS)[number]

export const CONSUMABLES_MODES = ["listed", "separate"] as const
export type ConsumablesMode = (typeof CONSUMABLES_MODES)[number]

/**
 * The commercial terms of the contract. Effective-dated, because a rate change
 * must never rewrite what an earlier month billed (proven: Winters, cut from
 * $600 to $300 in July, re-priced June on the next accrual until the history
 * existed).
 */
export interface ServiceTerms {
  readonly billingMethod: BillingMethod
  readonly consumablesMode: ConsumablesMode
  readonly perVisitCents: number
  readonly flatMonthlyCents: number
}

/** The half-open service window [startsOn, endsOn). endsOn null = ongoing. */
export class TaskWindow {
  constructor(
    readonly startsOn: string,
    readonly endsOn: string | null = null,
  ) {
    if (endsOn !== null && endsOn < startsOn)
      throw new TaskRuleError(`window ends (${endsOn}) before it starts (${startsOn})`)
  }

  covers(date: string): boolean {
    return this.startsOn <= date && (this.endsOn === null || date <= this.endsOn)
  }

  /** True when the window closed strictly before `date` — the "is it over" test. */
  endedBefore(date: string): boolean {
    return this.endsOn !== null && this.endsOn < date
  }

  /** Any overlap with the month [monthStart, monthEnd] — the billing question. */
  overlapsMonth(monthStart: string, monthEnd: string): boolean {
    if (this.startsOn > monthEnd) return false
    return this.endsOn === null || this.endsOn >= monthStart
  }
}

/** How often the pool is serviced. ION's `serviceRepeat`, normalised. */
export class Cadence {
  constructor(
    readonly frequency: string | null,
    readonly daysPerWeek: number | null,
  ) {}

  /** Weekly-or-more is the "regular maintenance" shape peer grouping keys on. */
  get isWeeklyOrMore(): boolean {
    return (this.daysPerWeek ?? 0) >= 1
  }
}

/* ─────────────────────────────────────────────────────── what ION tells us */

/**
 * One row of ION truth about a task — from the roster report or a direct
 * per-task read. `lastVisitOn` is OUR fact, passed in because the closure
 * rule needs both sides and the aggregate must not query.
 */
export interface IonTaskObservation {
  readonly ionTaskId: string
  readonly endsOn: string | null
  readonly terms: ServiceTerms | null
  /** True when this observation came from an ION row that is itself active. */
  readonly rowIsActive: boolean
  /** The task's latest visit date, or null. */
  readonly lastVisitOn: string | null
  /** When the observation was made — the verification stamp. */
  readonly observedAt: string
  /** ION's raw Invoice Type string, kept verbatim for re-parsing. */
  readonly rawInvoiceType?: string | null
}

export interface WindowDecision {
  readonly status: TaskStatus
  readonly endsOn: string | null
  readonly reason: string
}

/* ────────────────────────────────────────────────────────── the aggregate */

export class Task {
  private _status: TaskStatus
  private _window: TaskWindow
  private _termsHistory: EffectiveHistory<ServiceTerms>
  private _ionVerifiedAt: string | null
  private _ionInvoiceType: string | null

  private constructor(
    readonly id: string,
    readonly ionTaskId: string | null,
    readonly customerId: number | null,
    status: TaskStatus,
    window: TaskWindow,
    readonly cadence: Cadence,
    termsHistory: EffectiveHistory<ServiceTerms>,
    readonly customerProvidesChems: boolean,
    ionVerifiedAt: string | null = null,
    ionInvoiceType: string | null = null,
  ) {
    this._status = status
    this._window = window
    this._termsHistory = termsHistory
    this._ionVerifiedAt = ionVerifiedAt
    this._ionInvoiceType = ionInvoiceType
  }

  /**
   * The ONLY way a task comes into existence. Invariants enforced here rather
   * than by whoever happens to be inserting:
   *
   *   I-T1 a task must name the customer who owes for it. ADR 006: the owner
   *        comes from ION's customer id, NEVER from the service location's
   *        owner (the REGINA mis-attribution).
   *   I-T2 terms must be present from the first day of the window — a task
   *        with no terms cannot bill and would accrue silent zeros.
   *   I-T3 the money field must match the billing method: a per-visit task
   *        carries a per-visit rate, a flat task carries a monthly rate.
   *        `do_not_invoice` carries neither.
   */
  static create(input: {
    id: string
    ionTaskId: string | null
    customerId: number | null
    window: TaskWindow
    cadence: Cadence
    terms: ServiceTerms
    customerProvidesChems?: boolean
    status?: TaskStatus
  }): Task {
    if (input.customerId === null)
      throw new TaskRuleError("I-T1: a task must have a customer — bills cannot be addressed otherwise")
    assertTermsCoherent(input.terms)
    return new Task(
      input.id, input.ionTaskId, input.customerId,
      input.status ?? "active", input.window, input.cadence,
      new EffectiveHistory<ServiceTerms>([
        { from: input.window.startsOn, to: null, value: input.terms },
      ]),
      input.customerProvidesChems ?? false,
    )
  }

  /** Rehydrate from storage — no invariants re-run; the DB already holds them. */
  static rehydrate(input: {
    id: string
    ionTaskId: string | null
    customerId: number | null
    status: TaskStatus
    window: TaskWindow
    cadence: Cadence
    terms: readonly Effective<ServiceTerms>[]
    customerProvidesChems: boolean
    ionVerifiedAt?: string | null
    ionInvoiceType?: string | null
  }): Task {
    return new Task(
      input.id, input.ionTaskId, input.customerId, input.status, input.window,
      input.cadence, new EffectiveHistory(input.terms), input.customerProvidesChems,
      input.ionVerifiedAt ?? null, input.ionInvoiceType ?? null,
    )
  }

  get status(): TaskStatus { return this._status }
  get window(): TaskWindow { return this._window }
  get ionVerifiedAt(): string | null { return this._ionVerifiedAt }
  get ionInvoiceType(): string | null { return this._ionInvoiceType }
  get termsHistory(): readonly Effective<ServiceTerms>[] { return this._termsHistory.all }

  /** The terms in force on a date — null when nothing covers it. */
  termsOn(date: string): ServiceTerms | null {
    return this._termsHistory.on(date)
  }

  /**
   * Re-term the contract from a date forward. Closes the open period at
   * `effectiveFrom` rather than overwriting it, so history stays intact.
   *
   *   I-T4 terms may not be re-termed into the past beyond an existing
   *        boundary — that would rewrite a period we may already have billed.
   */
  retermFrom(effectiveFrom: string, terms: ServiceTerms): void {
    assertTermsCoherent(terms)
    const periods = [...this._termsHistory.all]
    const latest = periods.find((p) => p.to === null)
    if (latest && effectiveFrom < latest.from)
      throw new TaskRuleError(
        `I-T4: cannot re-term from ${effectiveFrom}; the open period began ${latest.from}`)
    const rebuilt: Effective<ServiceTerms>[] = periods.map((p) =>
      p.to === null ? { from: p.from, to: effectiveFrom, value: p.value } : p)
    rebuilt.push({ from: effectiveFrom, to: null, value: terms })
    this._termsHistory = new EffectiveHistory(rebuilt.filter((p) => p.to === null || p.to > p.from))
  }

  /**
   * THE CLOSURE RULE, and the reason this aggregate exists.
   *
   * ION's end date is a claim, not a fact. A task whose ION window has closed
   * but which has visits AFTER that date is still being serviced — ION's date
   * is simply stale, and closing on it would strand real visits on a closed
   * task where billing cannot see them. Conversely a genuinely ended task must
   * close, or it accrues forever.
   *
   *   I-T5 never close a task that has a visit after its ION end date.
   *   I-T6 never close from an ION row that is not itself active — a merged
   *        task bundles several ion_task_ids and one ended sub-task must not
   *        close the bundle.
   *
   * Returns the decision (pure) AND applies it, so callers cannot apply a
   * different one than they were told.
   */
  observeFromIon(obs: IonTaskObservation): WindowDecision {
    this._ionVerifiedAt = obs.observedAt
    if (obs.rawInvoiceType !== undefined) this._ionInvoiceType = obs.rawInvoiceType
    if (obs.terms) {
      const current = this.termsOn(obs.observedAt.slice(0, 10))
      if (!current || !sameTerms(current, obs.terms))
        this.retermFrom(obs.observedAt.slice(0, 10), obs.terms)
    }

    const decision = this.decideWindow(obs)
    this._status = decision.status
    this._window = new TaskWindow(this._window.startsOn, decision.endsOn)
    return decision
  }

  /** The closure decision alone — exposed so a dry run can preview it. */
  decideWindow(obs: IonTaskObservation): WindowDecision {
    if (!obs.rowIsActive && obs.endsOn === null)
      return { status: this._status, endsOn: this._window.endsOn,
        reason: "I-T6: inactive ION row with no end date decides nothing" }

    if (obs.endsOn === null)
      return { status: "active", endsOn: null, reason: "ION reports no end date — ongoing" }

    const endedByNow = obs.lastVisitOn !== null && obs.endsOn < obs.lastVisitOn
    if (endedByNow)
      return { status: "active", endsOn: null,
        reason: `I-T5: visits continue past ION's end (${obs.lastVisitOn} > ${obs.endsOn}) — the end date is stale` }

    return { status: "closed", endsOn: obs.endsOn, reason: `ION end date ${obs.endsOn}, no later visits` }
  }

  /**
   * Is this task expected to produce charges in the month? The question
   * billing asks before it accrues, and scheduling asks before it plans.
   */
  isBillableIn(monthStart: string, monthEnd: string): boolean {
    if (this._status === "paused") return false
    if (!this._window.overlapsMonth(monthStart, monthEnd)) return false
    const terms = this.termsOn(monthStart)
    return terms !== null && terms.billingMethod !== "do_not_invoice"
  }

  /**
   * Verification age in days at `asOf`, or null when never verified DIRECTLY
   * against ION. Null is a finding, not a pass: the active-roster sync cannot
   * see a task that left the roster, so silence proves nothing.
   */
  verificationAgeDays(asOf: string): number | null {
    if (!this._ionVerifiedAt) return null
    const ms = Date.parse(asOf) - Date.parse(this._ionVerifiedAt)
    return Math.floor(ms / 86_400_000)
  }

  pause(reason: string): void {
    if (this._status === "closed") throw new TaskRuleError("cannot pause a closed task")
    void reason
    this._status = "paused"
  }

  resume(): void {
    if (this._status === "closed") throw new TaskRuleError("cannot resume a closed task")
    this._status = "active"
  }
}

/* ─────────────────────────────────────────────────────────────── helpers */

function assertTermsCoherent(t: ServiceTerms): void {
  if (t.billingMethod === "per_visit" && t.perVisitCents <= 0 && t.flatMonthlyCents > 0)
    throw new TaskRuleError("I-T3: a per-visit task carries a per-visit rate, not a monthly one")
  if (t.billingMethod === "flat_rate_monthly" && t.flatMonthlyCents <= 0 && t.perVisitCents > 0)
    throw new TaskRuleError("I-T3: a flat-rate task carries a monthly rate, not a per-visit one")
}

const sameTerms = (a: ServiceTerms, b: ServiceTerms): boolean =>
  a.billingMethod === b.billingMethod &&
  a.consumablesMode === b.consumablesMode &&
  a.perVisitCents === b.perVisitCents &&
  a.flatMonthlyCents === b.flatMonthlyCents

/**
 * ION's single "Invoice Type" string carries TWO independent decisions. The
 * anti-corruption parse lives here, at the boundary, so no rule downstream
 * ever sees ION's vocabulary.
 */
export function parseIonInvoiceType(raw: string | null | undefined): {
  billingMethod: BillingMethod
  consumablesMode: ConsumablesMode
} {
  const s = (raw ?? "").toLowerCase()
  return {
    billingMethod: s.includes("do not invoice")
      ? "do_not_invoice"
      : s.includes("flat")
        ? "flat_rate_monthly"
        : "per_visit",
    consumablesMode: s.includes("separate consumables") ? "separate" : "listed",
  }
}
