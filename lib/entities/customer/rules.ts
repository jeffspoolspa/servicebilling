import type { Customer } from "./types"

export class RuleViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleViolation"
  }
}

/**
 * Business invariants for the Customer entity.
 * Throws RuleViolation on any violation. Called by every mutation.
 */
export function assertCustomerRules(current: Customer, patch: Partial<Customer>) {
  if (patch.is_active === false && current.open_balance > 0) {
    throw new RuleViolation(
      `Cannot deactivate customer with open balance of $${current.open_balance.toFixed(2)}`,
    )
  }

  if (patch.email !== undefined && patch.email !== null && !isValidEmail(patch.email)) {
    throw new RuleViolation(`Invalid email: ${patch.email}`)
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
