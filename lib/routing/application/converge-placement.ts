/**
 * ConvergePlacement — the single writer of routing.placement_versions.
 *
 * One sentence: "make the quota for this agreement era hold the stop set the
 * latest ION translation observed." Level-triggered and idempotent: running
 * it twice with the same translation does nothing the second time.
 *
 *   translation (agreements intake) ──► quota for the CURRENT terms era
 *                                        └► append placement version iff the
 *                                           stop set actually moved
 *
 * The Deen invariant is asserted here as a translation self-consistency
 * check: one form produced both the frequency (terms) and the stops, so a
 * count mismatch cannot mean "customer disagreement" — it means the
 * translation is broken, and we refuse to write rather than store a lie.
 */

import type { PlacementCause, PlacementStop, QuotaStore } from "../domain/ports/quota-store"

export class PlacementRuleError extends Error {}

/** Cadence as the translation records it (lib/external/ion/task-translation). */
export type RequiredCadence =
  | { kind: "weekly"; timesPerWeek: number }
  | { kind: "biweekly" }
  | { kind: "monthly" }

/** Typed pattern (RULED 2026-08-08): cadence per stop type. */
export type RequiredPattern = Partial<Record<"clean" | "chem_check", RequiredCadence>>

/** How many standing stops one cadence calls for. Interval cadences are one
 *  visit from one start date (ION has no day picker for them) — one stop. */
export function requiredStopCount(freq: RequiredCadence): number {
  return freq.kind === "weekly" ? freq.timesPerWeek : 1
}

const normalized = (stops: readonly PlacementStop[]) =>
  JSON.stringify(
    [...stops]
      .map((s) => ({ weekday: s.weekday, techId: s.techId, type: s.type }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.weekday - b.weekday || a.techId.localeCompare(b.techId)),
  )

export interface ConvergeInput {
  readonly agreementId: string
  readonly termsVersion: number
  readonly pattern: RequiredPattern
  readonly stops: readonly PlacementStop[]
  readonly fromDate: string // ISO date the observed set applies from
  readonly cause: PlacementCause
}

export type ConvergeOutcome =
  | { action: "opened"; quotaId: string } // quota minted, placement v1 written
  | { action: "appended"; quotaId: string; version: number } // stop set moved
  | { action: "unchanged"; quotaId: string }

export async function convergePlacement(store: QuotaStore, input: ConvergeInput): Promise<ConvergeOutcome> {
  // the Deen invariant, per TYPE: each cadence's stop count must match
  for (const type of ["clean", "chem_check"] as const) {
    const cadence = input.pattern[type]
    const ofType = input.stops.filter((s) => s.type === type)
    if (!cadence && ofType.length) {
      throw new PlacementRuleError(`stops carry type "${type}" the pattern does not require`)
    }
    if (cadence && ofType.length !== requiredStopCount(cadence)) {
      throw new PlacementRuleError(
        `translation self-inconsistent: ${type} requires ${requiredStopCount(cadence)} stop(s) but carries ${ofType.length}`,
      )
    }
  }

  const existing = await store.quotaFor(input.agreementId, input.termsVersion)
  if (!existing) {
    const quota = await store.mintQuota(input.agreementId, input.termsVersion)
    await store.appendPlacement(quota.id, 1, input.stops, input.fromDate, input.cause)
    return { action: "opened", quotaId: quota.id }
  }

  const head = await store.headPlacement(existing.id)
  if (head && normalized(head.stops) === normalized(input.stops)) {
    return { action: "unchanged", quotaId: existing.id }
  }
  const version = (head?.version ?? 0) + 1
  await store.appendPlacement(existing.id, version, input.stops, input.fromDate, input.cause)
  return { action: "appended", quotaId: existing.id, version }
}
