/**
 * ScenarioChange — the CLOSED vocabulary of changes a scenario may request
 * (RULED 2026-08-08). Every change entering the pipeline is one of these,
 * explicitly; nothing is "derived on the way through". A stranger kind
 * refuses — a new kind of change is a ruling, never a fallthrough.
 *
 *   StopMoved      routing: (weekday,tech) -> (weekday,tech), coverage kept
 *   AnchorShifted  routing: an INTERVAL quota takes the other week(s) —
 *                  a REQUESTED parity target, honored by superseding the
 *                  ION task with a StartsOn that puts the next visit inside
 *                  the cadence window (biweekly: gap <= 20 days). Never
 *                  silently re-derived by the planner.
 *   StopRemoved    NOT a routing change: coverage change = the agreements
 *                  road (terms). Classified here so callers route it,
 *                  never execute it.
 */

export interface Placement {
  readonly weekday: number
  readonly techId: string
}

export type ScenarioChange =
  | { kind: "StopMoved"; quotaId: string; from: Placement; to: Placement }
  | { kind: "AnchorShifted"; quotaId: string; fromAnchorWeek: number; toAnchorWeek: number }
  | { kind: "StopRemoved"; quotaId: string; from: Placement; reason: string }

export type ChangeIntake =
  | { ok: true; changes: ScenarioChange[]; agreementsRoad: ScenarioChange[] }
  | { ok: false; failed: string; raw: unknown }

/** FACTORY for stored scenario rows. Strangers refuse; StopRemoved is
 *  separated onto the agreements road (it may not enter the planner as a
 *  move). */
export function scenarioChangesFrom(raw: unknown): ChangeIntake {
  if (!Array.isArray(raw)) return { ok: false, failed: "changes is not an array", raw }
  const changes: ScenarioChange[] = []
  const agreementsRoad: ScenarioChange[] = []
  for (const c of raw as Record<string, unknown>[]) {
    switch (c.kind) {
      case "StopMoved":
        if (!c.quotaId || !c.from || !c.to) return { ok: false, failed: "StopMoved missing quotaId/from/to", raw: c }
        changes.push(c as never)
        break
      case "AnchorShifted":
        if (!c.quotaId || c.toAnchorWeek === undefined || c.fromAnchorWeek === undefined) {
          return { ok: false, failed: "AnchorShifted missing quotaId/fromAnchorWeek/toAnchorWeek", raw: c }
        }
        changes.push(c as never)
        break
      case "StopRemoved":
        agreementsRoad.push(c as never)
        break
      default:
        return { ok: false, failed: `unknown change kind "${String(c.kind)}" — extend the vocabulary on purpose`, raw: c }
    }
  }
  return { ok: true, changes, agreementsRoad }
}
