import type { TaskTranslation } from "./task-translation"

/**
 * IonWritePlan — HOW ION must be written to realize a target arrangement
 * (RULED 2026-08-08: relocated from the domain — `amend | supersede` fails
 * the exit test; delete ION and only "terms changed effective week X"
 * survives, which is the agreement's TermsVersion, not this).
 *
 * I-T8 lives here now, unchanged in spirit: the KIND is decided by WHAT
 * MOVED — computed from the diff between ION's current representation (the
 * fresh translation) and the target — never chosen by a caller. A caller
 * that could choose would eventually choose to rewrite an anchor.
 *
 *   commercial moved (pattern/billing/period) → supersede (ION regenerates
 *     visits from StartsOn; anchors cannot be rewritten in place)
 *   day-set moved (which weekdays)            → supersede (the anchor's
 *     weekday must move)
 *   only tech VALUES moved                    → amend (same id predicted)
 *   nothing moved                             → none (no write leaves)
 *
 * `effectiveWeekOf` stays SEMANTIC (business time); rendering the concrete
 * StartsOn/EndsOn strings — right weekday, right parity, not in the past —
 * is acl.ts's job at perform time.
 */

/** Structural twin of the agreements module's Arrangement — declared here
 *  so the border imports no domain module (and the domain imports no
 *  border). TypeScript's structural typing makes the real Arrangement
 *  satisfy it at the call site. */
export interface ArrangementLike {
  readonly pattern: TaskTranslation["schedule"]["frequency"]
  readonly billing: TaskTranslation["billing"]
  readonly period: { startsOn: string | null; endsOn: string | null }
  readonly stops: readonly { weekday: number; techId: string }[]
  readonly note: string
}

export type IonWritePlan =
  | { kind: "amend"; target: ArrangementLike }
  | { kind: "supersede"; target: ArrangementLike; effectiveWeekOf: string }
  | { kind: "none" }

export function planWrite(
  current: TaskTranslation,
  target: ArrangementLike,
  effectiveWeekOf: string,
): IonWritePlan {
  const j = (v: unknown) => JSON.stringify(v)
  const commercialMoved =
    j(current.schedule.frequency) !== j(target.pattern) ||
    j(current.billing) !== j(target.billing) ||
    j(current.schedule.period) !== j(target.period)
  const daySet = (s: readonly { weekday: number }[]) => [...s.map((x) => x.weekday)].sort().join(",")
  const daysMoved = daySet(current.schedule.stops) !== daySet(target.stops)
  if (commercialMoved || daysMoved) return { kind: "supersede", target, effectiveWeekOf }

  const byDay = new Map<number, string>(current.schedule.stops.map((s) => [s.weekday, s.techId]))
  const techsMoved = target.stops.some((s) => byDay.get(s.weekday) !== s.techId)
  return techsMoved ? { kind: "amend", target } : { kind: "none" }
}
