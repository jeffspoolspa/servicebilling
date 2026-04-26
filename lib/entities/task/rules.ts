import type { Task, TaskStatus } from "./types"

export class RuleViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleViolation"
  }
}

const validStatusTransitions: Record<TaskStatus, TaskStatus[]> = {
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: [], // terminal — open a new task instead
}

export function assertValidStatusTransition(current: Task, next: TaskStatus) {
  if (current.status === next) return
  const allowed = validStatusTransitions[current.status]
  if (!allowed.includes(next)) {
    throw new RuleViolation(
      `Cannot transition task ${current.id} from ${current.status} to ${next}`,
    )
  }
}

/** Generic invariants applied to every patch. */
export function assertTaskRules(_current: Task, patch: Partial<Task>) {
  if (
    patch.price_per_visit_cents !== undefined &&
    patch.price_per_visit_cents !== null &&
    patch.price_per_visit_cents < 0
  ) {
    throw new RuleViolation("price_per_visit_cents cannot be negative")
  }
  if (
    patch.chem_budget_cents !== undefined &&
    patch.chem_budget_cents !== null &&
    patch.chem_budget_cents < 0
  ) {
    throw new RuleViolation("chem_budget_cents cannot be negative")
  }
  if (
    patch.day_of_week !== undefined &&
    patch.day_of_week !== null &&
    (patch.day_of_week < 0 || patch.day_of_week > 6)
  ) {
    throw new RuleViolation(`day_of_week must be 0..6 (got ${patch.day_of_week})`)
  }
  if (patch.status === "paused" && patch.pause_reason === undefined) {
    // Soft warning, not enforced — reason can be set in a follow-up edit.
  }
}
