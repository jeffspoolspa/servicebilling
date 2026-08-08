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

/** Frequency as the translation records it (lib/external/ion/task-translation). */
export type RequiredFrequency =
  | { kind: "weekly"; timesPerWeek: number }
  | { kind: "biweekly" }
  | { kind: "monthly" }

/** How many standing stops a requirement calls for. Interval cadences are one
 *  visit from one start date (ION has no day picker for them) — one stop. */
export function requiredStopCount(freq: RequiredFrequency): number {
  return freq.kind === "weekly" ? freq.timesPerWeek : 1
}

const normalized = (stops: readonly PlacementStop[]) =>
  JSON.stringify(
    [...stops]
      .map((s) => ({ weekday: s.weekday, techId: s.techId }))
      .sort((a, b) => a.weekday - b.weekday || a.techId.localeCompare(b.techId)),
  )

export interface ConvergeInput {
  readonly agreementId: string
  readonly termsVersion: number
  readonly frequency: RequiredFrequency
  readonly stops: readonly PlacementStop[]
  readonly fromDate: string // ISO date the observed set applies from
  readonly cause: PlacementCause
}

export type ConvergeOutcome =
  | { action: "opened"; quotaId: string } // quota minted, placement v1 written
  | { action: "appended"; quotaId: string; version: number } // stop set moved
  | { action: "unchanged"; quotaId: string }

export async function convergePlacement(store: QuotaStore, input: ConvergeInput): Promise<ConvergeOutcome> {
  const required = requiredStopCount(input.frequency)
  if (input.stops.length !== required) {
    throw new PlacementRuleError(
      `translation self-inconsistent: frequency requires ${required} stop(s) but carries ${input.stops.length}`,
    )
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
