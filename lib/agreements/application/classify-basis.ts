/**
 * ClassifyBasis — one rule, used everywhere an agreement is minted or
 * re-based: which shape of Basis does this program get for this customer?
 *
 * Data-grounded 2026-08-08 (the live book): all 3 quality-control tasks and
 * 2 of 4 green pools sit on customers with an active maintenance agreement —
 * those are riders. A green pool or QC with no host stands alone as its own
 * customer_contract (a green-to-clean for a brand-new customer IS the
 * contract; the maintenance agreement usually follows it).
 */

import type { Basis, Program } from "../domain/service-agreement/basis"

export interface HostLookup {
  /** The customer's active maintenance agreement, if any — the rider host. */
  activeMaintenanceAgreement(customerId: string): Promise<{ id: string } | null>
}

export async function classifyBasis(
  program: Program,
  customerId: string,
  hosts: HostLookup,
): Promise<Basis> {
  if (program === "quality_control" || program === "green_to_clean") {
    const host = await hosts.activeMaintenanceAgreement(customerId)
    if (host) return { kind: "rider", program, riderOf: host.id }
  }
  return { kind: "customer_contract", program }
}
