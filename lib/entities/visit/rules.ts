import type { Visit, VisitStatus } from "./types"

export class RuleViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleViolation"
  }
}

const validTransitions: Record<VisitStatus, VisitStatus[]> = {
  scheduled: ["in_progress", "skipped", "canceled"],
  in_progress: ["completed", "skipped"],
  completed: [], // terminal
  skipped: ["scheduled"],
  canceled: ["scheduled"],
}

export function assertValidStatusTransition(visit: Visit, next: VisitStatus) {
  if (visit.status === next) return
  const allowed = validTransitions[visit.status]
  if (!allowed.includes(next)) {
    throw new RuleViolation(
      `Cannot transition visit ${visit.id} from ${visit.status} to ${next}`,
    )
  }
}

/** Generic invariants on a visit patch. */
export function assertVisitRules(_current: Visit, patch: Partial<Visit>) {
  if (
    patch.price_cents !== undefined &&
    patch.price_cents !== null &&
    patch.price_cents < 0
  ) {
    throw new RuleViolation("price_cents cannot be negative")
  }
  if (
    patch.started_at !== undefined &&
    patch.ended_at !== undefined &&
    patch.started_at !== null &&
    patch.ended_at !== null &&
    new Date(patch.ended_at) < new Date(patch.started_at)
  ) {
    throw new RuleViolation("ended_at must be on or after started_at")
  }
}
