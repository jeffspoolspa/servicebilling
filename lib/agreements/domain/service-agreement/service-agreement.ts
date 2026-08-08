import { AggregateRoot, type DomainEvent } from "@/lib/domain/kernel"
import { AgreementRuleError } from "./agreement-rule-error"
import type { Basis } from "./basis"
import type { BillingShape } from "./billing-shape"
import type { DesiredWeek } from "./desired-week"
import type { IonIncarnation } from "./ion-incarnation"
import { samePattern, type RequiredPattern } from "./required-pattern"
import type { Revision } from "./revision"
import type { TermsVersion } from "./terms-version"

/**
 * ServiceAgreement — the standing service contract, OUR identity, with two
 * independent ledgers (RULED 2026-08-07):
 *
 *   termsVersions[]    WHAT WAS AGREED — churns only on commercial change
 *   ionIncarnations[]  the external-identity ledger — churns whenever ION
 *                      forces a new task id, each entry stamped with CAUSE
 *
 * They churn independently in both directions: a routing day-move appends a
 * placement_change incarnation and touches no version (the reroute is not
 * the agreement's history); an ION-side price edit versions the terms
 * inside one incarnation (I-T8 is OUR write discipline, not a law of ION).
 *
 * The ledger appends from the ECHO, never the prediction: outbound writes
 * record what ION actually did (recordIncarnation), and a prediction miss
 * is a loud fact, not a silent assumption.
 *
 * Inbound convergence (applyTranslation) is level-triggered: identical
 * meaning is silent; real change versions terms with full before→after
 * payloads (the events-sourced standard), provenance reflection.
 *
 * Riders (basis.internal_program.riderOf): ending the parent ends its
 * riders — a CROSS-aggregate reaction, so it travels as an event handler
 * consuming agreement_ended, each rider its own transaction. The invariant
 * here is only that a rider knows its parent.
 *
 * EXIT TEST: delete ION tomorrow and this class must remain coherent — ION
 * appears only as opaque reference ids inside the incarnation ledger.
 */
export class ServiceAgreement extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly customerId: string, // our customer identity (qbo id today)
    readonly basis: Basis,
    private versions: TermsVersion[],
    private incarnations: IonIncarnation[],
    private _status: "active" | "ended",
    private _endedOn: string | null,
  ) {
    super(id)
  }

  /* ------------------------------- creation ------------------------------- */

  /** A new agreement, from intake (onboarding draft or an ION-discovered
   *  task per the match-or-mint rule). One version, optionally one
   *  incarnation when ION already holds it. */
  static open(args: {
    id: string
    customerId: string
    basis: Basis
    pattern: RequiredPattern
    billing: BillingShape
    period: { startsOn: string | null; endsOn: string | null }
    ionTaskId?: string
    at: string
    provenance: "intent" | "reflection"
  }): ServiceAgreement {
    const v1: TermsVersion = {
      version: 1, pattern: args.pattern, billing: args.billing,
      period: args.period, from: args.at, cause: "opened",
    }
    const a = new ServiceAgreement(
      args.id, args.customerId, args.basis, [v1],
      args.ionTaskId ? [{ ionTaskId: args.ionTaskId, from: args.at, to: null, cause: "opened" }] : [],
      "active", null,
    )
    a.record(fact("agreement_opened", args.at, {
      customer_id: args.customerId, basis: args.basis, terms: v1,
      ion_task_id: args.ionTaskId ?? null, provenance: args.provenance,
    }, a.participants()))
    return a
  }

  static rehydrate(
    id: string, customerId: string, basis: Basis,
    versions: TermsVersion[], incarnations: IonIncarnation[],
    status: "active" | "ended", endedOn: string | null,
  ): ServiceAgreement {
    if (versions.length === 0) throw new AgreementRuleError("an agreement without terms is not an agreement")
    return new ServiceAgreement(id, customerId, basis, [...versions], [...incarnations], status, endedOn)
  }

  /* --------------------------------- reads -------------------------------- */

  get status(): "active" | "ended" {
    return this._status
  }
  get endedOn(): string | null {
    return this._endedOn
  }
  currentTerms(): TermsVersion {
    return this.versions[this.versions.length - 1]
  }
  termsHistory(): readonly TermsVersion[] {
    return this.versions
  }
  lineage(): readonly IonIncarnation[] {
    return this.incarnations
  }
  currentIonTaskId(): string | null {
    return this.incarnations.find((i) => i.to === null)?.ionTaskId ?? null
  }
  /** Terms as they stood on a date — the billing asOf question. */
  termsAsOf(date: string): TermsVersion | null {
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (this.versions[i].from <= date) return this.versions[i]
    }
    return null
  }

  /* --------------------------- inbound convergence ------------------------ */

  /**
   * Converge to what ION reports (requirement + billing sections of a
   * TaskTranslation — placements go to routing, never through here).
   * Level-triggered: no change, no version, no fact.
   */
  applyTranslation(
    t: {
      pattern: RequiredPattern
      billing: BillingShape
      period: { startsOn: string | null; endsOn: string | null }
    },
    at: string,
  ): void {
    if (this._status === "ended") return // history does not reopen from a stale scrape
    const cur = this.currentTerms()
    const changed =
      !samePattern(cur.pattern, t.pattern) ||
      JSON.stringify(cur.billing) !== JSON.stringify(t.billing) ||
      JSON.stringify(cur.period) !== JSON.stringify(t.period)
    if (!changed) return

    const next: TermsVersion = {
      version: cur.version + 1, pattern: t.pattern, billing: t.billing,
      period: t.period, from: at, cause: "ion_side",
    }
    this.versions.push(next)
    this.record(fact("agreement_terms_changed", at, {
      before: cur, after: next, provenance: "reflection",
    }, this.participants()))

    if (t.period.endsOn !== null && t.period.endsOn <= at.slice(0, 10)) {
      this.end(t.period.endsOn, at, "reflection")
    }
  }

  /* ------------------------------ outbound edits -------------------------- */

  /** Our commercial change (I-T8's supersede cases land here; tech-only
   *  amends never touch this aggregate at all). */
  changeTerms(
    t: { pattern: RequiredPattern; billing: BillingShape; period: { startsOn: string | null; endsOn: string | null } },
    at: string,
  ): void {
    if (this._status === "ended") throw new AgreementRuleError("an ended agreement cannot be changed")
    const cur = this.currentTerms()
    const next: TermsVersion = {
      version: cur.version + 1, pattern: t.pattern, billing: t.billing,
      period: t.period, from: at, cause: "our_edit",
    }
    this.versions.push(next)
    this.record(fact("agreement_terms_changed", at, {
      before: cur, after: next, provenance: "intent",
    }, this.participants()))
  }

  /**
   * I-T8: the shape of a revision is decided by WHAT MOVED, never by the
   * caller — a caller that could choose would eventually choose to rewrite
   * an anchor. Pure decision: records nothing (the sentence records terms
   * via changeTerms when commercial fields moved, and the ledger appends
   * from the ECHO after the write lands).
   *
   *   commercial moved (pattern/billing/period) → supersede
   *   day-set moved (which weekdays)            → supersede (anchor must move)
   *   only tech VALUES moved                    → amend (same id predicted)
   *   nothing moved                             → none (no write)
   */
  revise(desired: DesiredWeek, observed: readonly { weekday: number; techId: string }[], effectiveWeekOf: string): Revision {
    if (this._status === "ended") throw new AgreementRuleError("an ended agreement cannot be revised")
    const cur = this.currentTerms()
    const commercialMoved =
      !samePattern(cur.pattern, desired.pattern) ||
      JSON.stringify(cur.billing) !== JSON.stringify(desired.billing) ||
      JSON.stringify(cur.period) !== JSON.stringify(desired.period)
    const daySet = (s: readonly { weekday: number }[]) => [...s.map((x) => x.weekday)].sort().join(",")
    const daysMoved = daySet(desired.stops) !== daySet(observed)
    if (commercialMoved || daysMoved) return { kind: "supersede", week: desired, effectiveWeekOf }
    const byDay = new Map(observed.map((s) => [s.weekday, s.techId]))
    const techsMoved = desired.stops.some((s) => byDay.get(s.weekday) !== s.techId)
    return techsMoved ? { kind: "amend", week: desired } : { kind: "none" }
  }

  /** I7: placements end when the agreement ends — after the last owed
   *  period, not eagerly. Routing consumes the fact; riders' cascade is an
   *  event handler's job (cross-aggregate = eventual). */
  end(on: string, at: string, provenance: "intent" | "reflection"): void {
    if (this._status === "ended") return
    this._status = "ended"
    this._endedOn = on
    const open = this.incarnations.find((i) => i.to === null)
    if (open) this.closeIncarnation(open.ionTaskId, at)
    this.record(fact("agreement_ended", at, {
      ended_on: on, basis: this.basis, provenance,
    }, this.participants()))
  }

  /* ----------------------- the external-identity ledger ------------------- */

  /**
   * Append what the ECHO proved. `predicted` is what our write intended —
   * when ION disagrees (new id where we predicted amend, or the reverse),
   * reality is recorded AND a prediction_missed fact fires: our model of
   * ION drifted, and every future prediction is suspect until a human looks.
   */
  recordIncarnation(
    echo: { ionTaskId: string; cause: IonIncarnation["cause"] },
    at: string,
    predicted?: { newIncarnation: boolean },
  ): void {
    const open = this.incarnations.find((i) => i.to === null)
    const isNew = !open || open.ionTaskId !== echo.ionTaskId

    if (predicted !== undefined && predicted.newIncarnation !== isNew) {
      this.record(fact("ion_prediction_missed", at, {
        predicted_new_incarnation: predicted.newIncarnation, echo_ion_task_id: echo.ionTaskId,
        open_ion_task_id: open?.ionTaskId ?? null,
      }, this.participants()))
    }
    if (!isNew) return // echo says the id survived — nothing to append

    if (open) this.closeIncarnation(open.ionTaskId, at)
    this.incarnations.push({ ionTaskId: echo.ionTaskId, from: at, to: null, cause: echo.cause })
    this.record(fact("agreement_ion_task_superseded", at, {
      from_ion_task_id: open?.ionTaskId ?? null, to_ion_task_id: echo.ionTaskId, cause: echo.cause,
    }, this.participants()))
  }

  private closeIncarnation(ionTaskId: string, at: string): void {
    this.incarnations = this.incarnations.map((i) =>
      i.ionTaskId === ionTaskId && i.to === null ? { ...i, to: at } : i,
    )
  }

  /** Every fact carries the correlation ids — the rule that makes the
   *  cross-stream biography a query instead of archaeology. */
  private participants(): string[] {
    const ion = this.incarnations.filter((i) => i.to === null).map((i) => `ion_task:${i.ionTaskId}`)
    return [`agreement:${this.id}`, `customer:${this.customerId}`, ...ion]
  }
}

const fact = (type: string, at: string, payload: Record<string, unknown>, participants: string[]): DomainEvent => ({
  type, at, payload, participants,
})
