import type { WorkOrder, BillingStatus } from "./types"

export class RuleViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleViolation"
  }
}

const validTransitions: Record<BillingStatus, BillingStatus[]> = {
  not_billable: ["needs_classification"],
  needs_classification: ["ready_to_match", "not_billable", "on_hold"],
  ready_to_match: ["matched", "needs_review", "on_hold"],
  matched: ["synced", "needs_review"],
  synced: ["needs_review"],
  needs_review: ["ready_to_match", "matched", "on_hold", "skipped"],
  on_hold: ["needs_classification", "ready_to_match", "skipped"],
  skipped: ["needs_classification"],
}

export function assertValidTransition(wo: WorkOrder, next: BillingStatus) {
  const allowed = validTransitions[wo.billing_status]
  if (!allowed.includes(next)) {
    throw new RuleViolation(
      `Cannot transition WO ${wo.wo_number} from ${wo.billing_status} to ${next}`,
    )
  }
}
