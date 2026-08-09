/**
 * RefreshAgreement — THE SENTENCE: bring one agreement back into agreement
 * with ION. Fetch every open slice's form, translate, record the intake,
 * then converge terms and placements; whatever refuses goes to quarantine
 * and the agreement stays untouched until the picture is whole.
 *
 *   open incarnations ─► forms (one batch) ─► translate ─► intake ledger
 *        └─ any slice failed? STOP: a partial picture composed into a
 *           typed pattern would read as a real change (a missing chem
 *           slice looks like chem service being cancelled). Refuse to
 *           converge on a lie; report partial.
 *   all slices ok ─► compose typed pattern/billing ─► applyTranslation
 *   (terms, level-triggered) ─► convergePlacement (stops, level-triggered)
 *
 * Level-triggered and idempotent: an unchanged agreement produces zero
 * writes beyond the intake observations, zero facts, action "unchanged".
 */

import type { RequiredPattern, StopType } from "../domain/service-agreement/required-pattern"
import type { TypedBilling, BillingShape, DayRate } from "../domain/service-agreement/billing-shape"
import type { AgreementRepository } from "../domain/ports/agreement-repository"
import type { IntakeStore } from "../domain/ports/intake-store"
import type { TaskFormSource } from "../domain/ports/task-form-source"
import type { QuotaStore, PlacementStop } from "../../routing/domain/ports/quota-store"
import { convergePlacement } from "../../routing/application/converge-placement"
import { ionTaskFormFrom, translateTask, type TaskTranslation } from "../../external/ion/task-translation"
import { AgreementRuleError } from "../domain/service-agreement/agreement-rule-error"

export interface RefreshReport {
  agreementId: string
  slices: number
  translated: number
  quarantined: number
  partial: boolean
  coversDrift: string[] // ionTaskIds whose stopType no longer matches covers
  /** price groups within a type whose day sets OVERLAP — the condition
   *  card cannot represent them (same type, same day, two prices). Terms
   *  carry the deterministic representative; a human untangles. Normal
   *  multi-rate slices (disjoint days) become dayRates, not flags. */
  mixedBilling: string[]
  terms: "unchanged" | "versioned" | "ended"
  placement: "unchanged" | "appended" | "opened" | "skipped"
}

export interface RefreshDeps {
  repo: AgreementRepository
  intake: IntakeStore
  forms: TaskFormSource
  quotas: QuotaStore
  catalogPriceCents: (serviceTypeId: string) => number | null
}

export async function refreshAgreement(
  deps: RefreshDeps,
  agreementId: string,
  at: string, // ISO instant of this observation
): Promise<RefreshReport> {
  const report: RefreshReport = {
    agreementId, slices: 0, translated: 0, quarantined: 0,
    partial: false, coversDrift: [], mixedBilling: [], terms: "unchanged", placement: "skipped",
  }

  const agreement = await deps.repo.byId(agreementId)
  if (!agreement) throw new AgreementRuleError(`no agreement ${agreementId}`)
  if (agreement.status === "ended") return report

  const open = agreement.openIncarnations()
  report.slices = open.length
  if (!open.length) return report

  // the fetch list: ionCustId comes from each slice's latest stored
  // translation (every incarnation was born from one)
  const fetchList: { ionTaskId: string; ionCustId: string }[] = []
  for (const inc of open) {
    const last = await deps.intake.latest(inc.ionTaskId)
    const ionCustId = (last?.translation as { ionCustomerId?: string } | null)?.ionCustomerId
    if (!ionCustId) {
      await deps.intake.recordFailure(inc.ionTaskId, at, "no prior translation carries ionCustomerId — cannot prime the form", {})
      report.quarantined++
      continue
    }
    fetchList.push({ ionTaskId: inc.ionTaskId, ionCustId })
  }

  const translations = new Map<string, TaskTranslation>()
  if (fetchList.length) {
    const results = await deps.forms.fetchForms(fetchList)
    for (const res of results) {
      if (!res.ok) {
        await deps.intake.recordFailure(res.ionTaskId, at, `fetch: ${res.error}`, {})
        report.quarantined++
        continue
      }
      const intake = ionTaskFormFrom({ fields: res.fields, detail: res.detail as never })
      if (!intake.ok) {
        await deps.intake.recordFailure(res.ionTaskId, at, intake.failed, intake.raw)
        report.quarantined++
        continue
      }
      const tr = translateTask(intake.value, deps.catalogPriceCents)
      if (!tr.ok) {
        await deps.intake.recordFailure(res.ionTaskId, at, tr.failed, tr.raw)
        report.quarantined++
        continue
      }
      await deps.intake.recordTranslation(tr.value.ionTaskId, at, tr.value, {})
      report.translated++
      translations.set(tr.value.ionTaskId, tr.value)
    }
  }

  // covers drift: a slice whose form now carries a DIFFERENT stop type is
  // not a refresh — it is a redefinition, and converging it under the old
  // covers would mislabel every stop. Surface it; a human (or the
  // match-or-mint road) re-bases the slice.
  for (const inc of open) {
    const t = translations.get(inc.ionTaskId)
    if (t && t.stopType !== inc.covers.stopType) {
      report.coversDrift.push(inc.ionTaskId)
      translations.delete(inc.ionTaskId)
    }
  }

  if (translations.size < open.length) {
    report.partial = true
    return report // refuse to converge on a partial picture
  }

  // compose the typed terms from ALL slices (the remint's era rule)
  const slices = [...translations.values()]
  const pattern: RequiredPattern = {}
  const billing: TypedBilling = {}
  for (const type of ["clean", "chem_check"] as StopType[]) {
    const ofType = slices.filter((s) => s.stopType === type)
      .sort((a, b) => a.ionTaskId.localeCompare(b.ionTaskId))
    if (!ofType.length) continue
    const nonWeekly = ofType.filter((s) => s.schedule.frequency.kind !== "weekly")
    if (nonWeekly.length > 1) throw new AgreementRuleError(`two ${type} slices with interval cadences — unrepresentable`)
    if (ofType.length === 1 && nonWeekly.length === 1) pattern[type] = ofType[0].schedule.frequency
    else {
      const days = new Set(ofType.flatMap((s) => s.schedule.stops.map((x) => x.weekday)))
      pattern[type] = { kind: "weekly", timesPerWeek: Math.min(Math.max(days.size, 1), 7) as 1 }
    }

    // the condition card (RULED): price groups within a type become the
    // default (lowest price) + dayRates for the premium groups, days =
    // each group's observed stop days. Overlapping day sets cannot be
    // carded (same type+day, two prices) — flag, keep the representative.
    const byPrice = new Map<number | null, typeof ofType>()
    for (const sl of ofType) {
      const price = (sl.billing as { priceCents: number | null }).priceCents
      byPrice.set(price, [...(byPrice.get(price) ?? []), sl])
    }
    const base = ofType[0].billing as unknown as BillingShape
    if (byPrice.size <= 1) {
      billing[type] = base
    } else {
      const groups = [...byPrice.entries()]
        .map(([priceCents, sls]) => ({
          priceCents,
          days: [...new Set(sls.flatMap((sl) => sl.schedule.stops.map((x) => x.weekday)))].sort(),
        }))
        .sort((a, b) => (a.priceCents ?? 0) - (b.priceCents ?? 0))
      const overlap = groups.some((g, i) =>
        groups.slice(i + 1).some((h) => g.days.some((d) => h.days.includes(d))))
      if (overlap || groups.some((g) => g.priceCents === null)) {
        report.mixedBilling.push(`${type}: ${groups.map((g) => g.priceCents).join("/")} (uncardable)`)
        billing[type] = base
      } else {
        const [dflt, ...premium] = groups
        const dayRates: DayRate[] = premium.map((g) => ({ days: g.days, priceCents: g.priceCents! }))
        billing[type] = { ...base, priceCents: dflt.priceCents, dayRates }
      }
    }
  }
  const starts = slices.map((s) => s.schedule.period.startsOn).filter(Boolean).sort()
  const endsAll = slices.every((s) => s.schedule.period.endsOn !== null)
  const period = {
    startsOn: starts[0] ?? null,
    endsOn: endsAll ? slices.map((s) => s.schedule.period.endsOn!).sort().pop()! : null,
  }

  const versionsBefore = agreement.termsHistory().length
  agreement.applyTranslation({ pattern, billing, period }, at)
  await deps.repo.save(agreement)
  const endedNow = agreement.endedOn !== null
  report.terms = endedNow ? "ended"
    : agreement.termsHistory().length > versionsBefore ? "versioned" : "unchanged"

  if (endedNow) return report

  const stops: PlacementStop[] = slices.flatMap((s) =>
    s.schedule.stops.map((x) => ({ weekday: x.weekday, techId: x.techId, type: s.stopType })),
  )
  const outcome = await convergePlacement(deps.quotas, {
    agreementId, termsVersion: agreement.currentTerms().version,
    pattern, stops, fromDate: at.slice(0, 10), cause: "ion_side",
  })
  report.placement = outcome.action
  return report
}
