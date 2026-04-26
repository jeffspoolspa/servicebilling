import type { Pool } from "./types"

export class RuleViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleViolation"
  }
}

/**
 * Business invariants for the Pool entity. Throws RuleViolation on any
 * violation. Called by every mutation.
 */
export function assertPoolRules(_current: Pool, patch: Partial<Pool>) {
  if (patch.gallons !== undefined && patch.gallons !== null && patch.gallons <= 0) {
    throw new RuleViolation(`Pool gallons must be positive (got ${patch.gallons})`)
  }

  if (
    patch.seasonal_close_from !== undefined &&
    patch.seasonal_close_to !== undefined &&
    patch.seasonal_close_from !== null &&
    patch.seasonal_close_to !== null &&
    patch.seasonal_close_to < patch.seasonal_close_from
  ) {
    throw new RuleViolation("seasonal_close_to must be on or after seasonal_close_from")
  }
}
