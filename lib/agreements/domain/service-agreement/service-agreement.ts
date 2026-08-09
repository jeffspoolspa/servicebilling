import { AggregateRoot, type DomainEvent } from "@/lib/domain/kernel"
import { AgreementRuleError } from "./agreement-rule-error"
import type { Basis } from "./basis"
import { sameBilling, type TypedBilling } from "./billing-shape"
import { isPending, type IncarnationIntent, type IonIncarnation } from "./ion-incarnation"
import { samePattern, type RequiredPattern } from "./required-pattern"
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
 * Riders (basis.rider.riderOf): ending the parent ends its
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
    billing: TypedBilling
    period: { startsOn: string | null; endsOn: string | null }
    incarnations?: { ionTaskId: string; covers: IonIncarnation["covers"] }[]
    at: string
    provenance: "intent" | "reflection"
  }): ServiceAgreement {
    const v1: TermsVersion = {
      version: 1, pattern: args.pattern, billing: args.billing,
      period: args.period, from: args.at, cause: "opened",
    }
    const a = new ServiceAgreement(
      args.id, args.customerId, args.basis, [v1],
      (args.incarnations ?? []).map((i) => ({
        id: newId(), ionTaskId: i.ionTaskId, from: args.at, to: null,
        cause: "opened" as const, covers: i.covers, landedAt: args.at,
      })),
      "active", null,
    )
    a.record(fact("agreement_opened", args.at, {
      customer_id: args.customerId, basis: args.basis, terms: v1,
      ion_task_ids: (args.incarnations ?? []).map((i) => i.ionTaskId), provenance: args.provenance,
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
  /** Everything standing: LANDED slices plus DECLARED ones ION has not
   *  confirmed. A pending declaration is part of the picture — hiding it
   *  is what "unrecorded supersession" meant. */
  openIncarnations(): readonly IonIncarnation[] {
    return this.incarnations.filter((i) => i.to === null && !i.abandonedAt)
  }
  /** Slices ION has confirmed — the only ones with a task id to write to. */
  landedIncarnations(): readonly IonIncarnation[] {
    return this.openIncarnations().filter((i) => i.ionTaskId !== null)
  }
  /** Declared, not yet confirmed. A publish in flight, or one that died. */
  pendingIncarnations(): readonly IonIncarnation[] {
    return this.openIncarnations().filter(isPending)
  }
  /** The open task carrying a slice; the singular read for one-task agreements. */
  currentIonTaskId(covers?: Partial<IonIncarnation["covers"]>): string | null {
    const open = this.openIncarnations().filter(
      (i) => !covers ||
        ((covers.stopType === undefined || i.covers.stopType === covers.stopType) &&
         (covers.ionProfileId === undefined || i.covers.ionProfileId === covers.ionProfileId)),
    )
    return open[0]?.ionTaskId ?? null
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
      billing: TypedBilling
      period: { startsOn: string | null; endsOn: string | null }
    },
    at: string,
  ): void {
    if (this._status === "ended") return // history does not reopen from a stale scrape
    const cur = this.currentTerms()
    // field compares only — JSON.stringify equality is a representation
    // trap (jsonb reorders keys; evidence fields churn) and re-versioned an
    // unchanged agreement twice on 2026-08-08 before this lesson stuck
    const changed =
      !samePattern(cur.pattern, t.pattern) ||
      !sameBilling(cur.billing, t.billing) ||
      cur.period.startsOn !== t.period.startsOn ||
      cur.period.endsOn !== t.period.endsOn
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
    t: { pattern: RequiredPattern; billing: TypedBilling; period: { startsOn: string | null; endsOn: string | null } },
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

  /** I7: placements end when the agreement ends — after the last owed
   *  period, not eagerly. Routing consumes the fact; riders' cascade is an
   *  event handler's job (cross-aggregate = eventual). */
  end(on: string, at: string, provenance: "intent" | "reflection"): void {
    if (this._status === "ended") return
    this._status = "ended"
    this._endedOn = on
    for (const open of this.landedIncarnations()) this.closeIncarnation(open.ionTaskId!, at)
    this.record(fact("agreement_ended", at, {
      ended_on: on, basis: this.basis, provenance,
    }, this.participants()))
  }

  /* ----------------------- the external-identity ledger ------------------- */

  /* ------------------------ write-ahead declaration ---------------------- */

  /**
   * DECLARE a supersession BEFORE ION is touched (RULED 2026-08-09):
   * "there should be no such thing as an unrecorded supersession." Our id
   * and the intended shape are recorded first, so every later state is
   * readable — landed, or pending with the intent that was attempted.
   * Returns the declaration id the caller lands or abandons.
   */
  declareIncarnation(
    d: { id: string; covers: IonIncarnation["covers"]; cause: IonIncarnation["cause"]; intent: IncarnationIntent },
    at: string,
  ): string {
    if (this._status === "ended") throw new AgreementRuleError("an ended agreement cannot declare a supersession")
    const already = this.pendingIncarnations().find(
      (i) => i.covers.stopType === d.covers.stopType && i.covers.ionProfileId === d.covers.ionProfileId,
    )
    // one intended supersession per slice at a time: a retry RESUMES the
    // declaration instead of declaring a second one (the duplicate class)
    if (already) return already.id

    this.incarnations.push({
      id: d.id, ionTaskId: null, from: at, to: null, cause: d.cause, covers: d.covers,
      intent: d.intent, declaredAt: at, landedAt: null, abandonedAt: null, abandonedReason: null,
    })
    this.record(fact("ion_supersession_declared", at, {
      declaration_id: d.id, covers: d.covers, cause: d.cause, intent: d.intent,
    }, this.participants()))
    return d.id
  }

  /**
   * LAND a declaration: ION's own state confirmed the born task. This is
   * where the predecessor closes — never before, so a failed create can
   * never leave the agreement with no standing slice.
   */
  landIncarnation(declarationId: string, ionTaskId: string, at: string): void {
    const d = this.incarnations.find((i) => i.id === declarationId)
    if (!d) throw new AgreementRuleError(`no declaration ${declarationId} on this agreement`)
    if (d.ionTaskId !== null) {
      if (d.ionTaskId !== ionTaskId) {
        throw new AgreementRuleError(`declaration ${declarationId} already landed as ${d.ionTaskId}, cannot land ${ionTaskId}`)
      }
      return // idempotent: the same landing twice is one landing
    }
    const predecessor = d.intent?.supersedes ?? null
    this.incarnations = this.incarnations.map((i) =>
      i.id === declarationId ? { ...i, ionTaskId, landedAt: at } : i,
    )
    if (predecessor) this.closeIncarnation(predecessor, at)
    this.record(fact("agreement_ion_task_superseded", at, {
      from_ion_task_id: predecessor, to_ion_task_id: ionTaskId,
      cause: d.cause, declaration_id: declarationId,
    }, this.participants()))
  }

  /** The write provably did not happen. The declaration closes with its
   *  reason; the predecessor keeps standing, untouched. */
  abandonDeclaration(declarationId: string, reason: string, at: string): void {
    const d = this.incarnations.find((i) => i.id === declarationId)
    if (!d || d.ionTaskId !== null || d.abandonedAt) return
    this.incarnations = this.incarnations.map((i) =>
      i.id === declarationId ? { ...i, abandonedAt: at, abandonedReason: reason, to: at } : i,
    )
    this.record(fact("ion_supersession_abandoned", at, {
      declaration_id: declarationId, reason, intent: d.intent ?? null,
    }, this.participants()))
  }

  /**
   * Append what the ECHO proved. `predicted` is what our write intended —
   * when ION disagrees (new id where we predicted amend, or the reverse),
   * reality is recorded AND a prediction_missed fact fires: our model of
   * ION drifted, and every future prediction is suspect until a human looks.
   */
  recordIncarnation(
    echo: { ionTaskId: string; cause: IonIncarnation["cause"]; covers: IonIncarnation["covers"] },
    at: string,
    predicted?: { newIncarnation: boolean },
  ): void {
    // supersession is per SLICE: the echo replaces the open incarnation
    // covering the same (stopType, profile), never its siblings
    const open = this.incarnations.find(
      (i) => i.to === null && i.ionTaskId !== null &&
        i.covers.stopType === echo.covers.stopType &&
        i.covers.ionProfileId === echo.covers.ionProfileId,
    )
    const isNew = !open || open.ionTaskId !== echo.ionTaskId

    if (predicted !== undefined && predicted.newIncarnation !== isNew) {
      this.record(fact("ion_prediction_missed", at, {
        predicted_new_incarnation: predicted.newIncarnation, echo_ion_task_id: echo.ionTaskId,
        open_ion_task_id: open?.ionTaskId ?? null,
      }, this.participants()))
    }
    if (!isNew) return // echo says the id survived — nothing to append

    if (open?.ionTaskId) this.closeIncarnation(open.ionTaskId, at)
    this.incarnations.push({
      id: newId(), ionTaskId: echo.ionTaskId, from: at, to: null,
      cause: echo.cause, covers: echo.covers, landedAt: at,
    })
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
    const ion = this.incarnations
      .filter((i) => i.to === null && i.ionTaskId !== null)
      .map((i) => `ion_task:${i.ionTaskId}`)
    return [`agreement:${this.id}`, `customer:${this.customerId}`, ...ion]
  }
}

/** ids are minted by the caller in production (the declaration id travels
 *  into ION's write); this is the fallback for reflected incarnations. */
const newId = (): string => globalThis.crypto.randomUUID()

const fact = (type: string, at: string, payload: Record<string, unknown>, participants: string[]): DomainEvent => ({
  type, at, payload, participants,
})
