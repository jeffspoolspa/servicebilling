/**
 * EditAgreement — THE ONE SENTENCE for a change to a standing agreement,
 * whichever direction it came from (RULED 2026-08-09, Carter):
 *
 *   "whether it's an outgoing change from us or an incoming change from
 *    ION they both go through the edit-agreement method that emits the
 *    fact which changes our placement or agreements"
 *
 * Before this, two orchestrators reached the same last step by different
 * roads with different composition rules — ChangeArrangement composed
 * stops as head-minus-slice-plus-target (where the phantom-stop bug
 * lived), RefreshAgreement composed them straight from the translations.
 * Same intent, two implementations, so a bug in one was invisible to the
 * other and neither owned a slice the book had not heard of.
 *
 * Now there is one composition rule and one convergence, and the ONLY
 * difference between the directions is PROVENANCE:
 *
 *   our_edit  — we decided it (a publish move)      -> intent
 *   ion_side  — we observed it (refresh, sweep)     -> reflection
 *
 * The aggregate always modelled it this way (one terms timeline, cause
 * our_edit | ion_side); this deletes the divergence above it.
 *
 * SLICE COMPOSITION (the one rule): the agreement's stop set is the union
 * of its OPEN slices' stops. A caller supplies the slices it knows about
 * (the publish knows its one target slice; the refresh knows all of
 * them); every other open slice contributes its last observed stops from
 * the intake ledger — the same source both roads already trust. A slice
 * whose stops nobody can state is REPORTED, never silently dropped: a
 * missing slice looks exactly like cancelled service.
 */

import type { AgreementRepository } from "../domain/ports/agreement-repository"
import type { IntakeStore } from "../domain/ports/intake-store"
import type { IonIncarnation } from "../domain/service-agreement/ion-incarnation"
import type { RequiredPattern } from "../domain/service-agreement/required-pattern"
import type { TypedBilling } from "../domain/service-agreement/billing-shape"
import { sameBilling } from "../domain/service-agreement/billing-shape"
import { samePattern } from "../domain/service-agreement/required-pattern"
import { AgreementRuleError } from "../domain/service-agreement/agreement-rule-error"
import type { PlacementStop, QuotaStore } from "../../routing/domain/ports/quota-store"
import { convergePlacement } from "../../routing/application/converge-placement"

export type EditOrigin = "our_edit" | "ion_side"

/** What one slice looks like after the change (the caller's knowledge). */
export interface SliceStops {
  ionTaskId: string
  stops: readonly { weekday: number; techId: string }[]
  stopType: IonIncarnation["covers"]["stopType"]
}

export interface AgreementEdit {
  agreementId: string
  origin: EditOrigin
  /** ISO instant the change was decided (us) or observed (ION). */
  at: string
  /** Commercial terms, when the change touches them. Omit for a pure
   *  reroute — a day-move is not the agreement's commercial history. */
  terms?: { pattern: RequiredPattern; billing: TypedBilling; period: { startsOn: string | null; endsOn: string | null } }
  /** The slices the caller can state. Others fill in from the ledger. */
  slices?: readonly SliceStops[]
  /** LAND a write-ahead declaration: ION's state confirmed the born task
   *  (write-ahead, RULED 2026-08-09). Preferred over `incarnation` for
   *  anything we wrote — the declaration already exists. */
  land?: { declarationId: string; ionTaskId: string }
  /** The declared write provably did not happen. */
  abandon?: { declarationId: string; reason: string }
  /** An external-id churn proved by a read-back (never a prediction).
   *  Used for changes we OBSERVE (ION-side), which had no declaration. */
  incarnation?: {
    ionTaskId: string
    cause: IonIncarnation["cause"]
    covers: IonIncarnation["covers"]
    predicted?: { newIncarnation: boolean }
  }
  /** An ending we can PROVE. Never inferred from missing slices — that is
   *  the mistake that ended 20 agreements on 2026-08-09. */
  endOn?: string
}

export interface AgreementEditReport {
  agreementId: string
  origin: EditOrigin
  terms: "unchanged" | "versioned" | "ended" | "skipped"
  incarnation: "unchanged" | "recorded" | "abandoned" | "skipped"
  placement: "unchanged" | "appended" | "opened" | "skipped"
  /** open slices whose stops nobody could state — the agreement's stop set
   *  would be a LIE, so placement is skipped and this is loud. */
  unstatedSlices: string[]
  /** placement refused (stale terms vs slices); ION is already written, so
   *  this is reported and healed by the next convergence, never thrown. */
  placementDeferred?: string
  /** the stop set this sentence composed for the WHOLE agreement — what a
   *  caller's done-gate re-reads the floor against. */
  composed?: PlacementStop[]
}

/** Where facts go. Optional so in-memory checks need no wiring. */
export interface FactSink {
  emit(rows: {
    aggregate: string; aggregateId: string; type: string; at: string
    participants: string[]; payload: Record<string, unknown>
  }[]): Promise<void>
}

export interface EditDeps {
  repo: AgreementRepository
  intake: IntakeStore
  quotas: QuotaStore
  /** TRACEABILITY (RULED 2026-08-09, Carter): "I should be able to easily
   *  trace each part of the workflow by looking for facts I know these
   *  calls should be emitting." The aggregate's own facts publish on save;
   *  the FLOOR changing emitted nothing until this. */
  facts?: FactSink
}

export async function editAgreement(deps: EditDeps, edit: AgreementEdit): Promise<AgreementEditReport> {
  const report: AgreementEditReport = {
    agreementId: edit.agreementId, origin: edit.origin,
    terms: "skipped", incarnation: "skipped", placement: "skipped", unstatedSlices: [],
  }

  const agreement = await deps.repo.byId(edit.agreementId)
  if (!agreement) throw new AgreementRuleError(`no agreement ${edit.agreementId}`)
  if (agreement.status === "ended" && !edit.endOn) return report

  /* ------------------------------- terms -------------------------------- */
  if (edit.terms) {
    const cur = agreement.currentTerms()
    const same =
      samePattern(cur.pattern, edit.terms.pattern) &&
      sameBilling(cur.billing, edit.terms.billing) &&
      cur.period.startsOn === edit.terms.period.startsOn &&
      cur.period.endsOn === edit.terms.period.endsOn
    if (same) {
      report.terms = "unchanged"
    } else {
      // provenance is the ONLY difference between the directions
      if (edit.origin === "ion_side") agreement.applyTranslation(edit.terms, edit.at)
      else agreement.changeTerms(edit.terms, edit.at)
      report.terms = agreement.endedOn !== null ? "ended" : "versioned"
    }
  }

  /* --------------------------- external identity ------------------------- */
  if (edit.land) {
    agreement.landIncarnation(edit.land.declarationId, edit.land.ionTaskId, edit.at)
    report.incarnation = "recorded"
  }
  if (edit.abandon) {
    agreement.abandonDeclaration(edit.abandon.declarationId, edit.abandon.reason, edit.at)
    report.incarnation = "abandoned"
  }
  if (edit.incarnation) {
    const before = agreement.openIncarnations().map((i) => i.ionTaskId).join(",")
    agreement.recordIncarnation(
      { ionTaskId: edit.incarnation.ionTaskId, cause: edit.incarnation.cause, covers: edit.incarnation.covers },
      edit.at,
      edit.incarnation.predicted,
    )
    report.incarnation = agreement.openIncarnations().map((i) => i.ionTaskId).join(",") === before
      ? "unchanged" : "recorded"
  }

  /* -------------------------------- ending ------------------------------- */
  if (edit.endOn) {
    agreement.end(edit.endOn, edit.at, edit.origin === "our_edit" ? "intent" : "reflection")
    report.terms = "ended"
  }

  await deps.repo.save(agreement)
  if (agreement.status === "ended") return report

  /* ------------------------------ placement ------------------------------ */
  // THE ONE COMPOSITION RULE: the union of the OPEN slices' stops. Stated
  // slices win; the rest come from their last observed translation.
  const stated = new Map((edit.slices ?? []).map((s) => [s.ionTaskId, s]))
  const open = agreement.openIncarnations()
  if (!open.length) return report

  const stops: PlacementStop[] = []
  for (const inc of open) {
    // a DECLARED-not-landed slice means a write is in flight or died: the
    // arrangement is not knowable yet, so the floor must not be rewritten
    // from a half-picture (write-ahead, RULED 2026-08-09)
    if (inc.ionTaskId === null) {
      report.unstatedSlices.push(`declaration:${inc.id} (declared, ION has not confirmed it)`)
      continue
    }
    const s = stated.get(inc.ionTaskId)
    if (s) {
      stops.push(...s.stops.map((x) => ({ weekday: x.weekday, techId: x.techId, type: s.stopType })))
      continue
    }
    const last = await deps.intake.latest(inc.ionTaskId)
    const t = last?.translation as { schedule?: { stops: { weekday: number; techId: string }[] } } | null
    if (!t?.schedule) { report.unstatedSlices.push(inc.ionTaskId); continue }
    stops.push(...t.schedule.stops.map((x) => ({ weekday: x.weekday, techId: x.techId, type: inc.covers.stopType })))
  }
  // a stop set missing a slice is not a smaller arrangement — it is an
  // unknown one. Converging it would delete real work from the floor.
  if (report.unstatedSlices.length) return report
  if (!stops.length) return report

  report.composed = stops
  try {
    const outcome = await convergePlacement(deps.quotas, {
      agreementId: agreement.id, termsVersion: agreement.currentTerms().version,
      pattern: agreement.currentTerms().pattern, stops,
      fromDate: edit.at.slice(0, 10), cause: edit.origin === "our_edit" ? "transition" : "ion_side",
    })
    report.placement = outcome.action
    if (outcome.action === "appended" || outcome.action === "opened") {
      await deps.facts?.emit([{
        aggregate: "agreement", aggregateId: agreement.id, type: "placement_converged", at: edit.at,
        participants: [
          `agreement:${agreement.id}`, `customer:${agreement.customerId}`,
          ...open.map((i) => `ion_task:${i.ionTaskId}`),
        ],
        payload: {
          origin: edit.origin,
          provenance: edit.origin === "our_edit" ? "intent" : "reflection",
          action: outcome.action,
          stops: stops.map((x) => ({ weekday: x.weekday, techId: x.techId, type: x.type })),
          terms_version: agreement.currentTerms().version,
        },
      }])
    }
  } catch (e) {
    report.placementDeferred = String(e).replace(/^Error: /, "")
  }
  return report
}
