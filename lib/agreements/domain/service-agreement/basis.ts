/** Why the work exists. Billability is NOT decided here — it is a policy
 *  outcome at accrual (BillingMonth composes agreement terms × month policy
 *  × visit facts). basis carries the WHY and the rider cascade.
 *
 *  Two shapes (RULED 2026-08-08):
 *  - customer_contract: the work stands on its own — regular maintenance, a
 *    standalone green-to-clean (the customer's pool, their contract, no host),
 *    a one-time clean.
 *  - rider: the work exists BECAUSE another active agreement exists — a
 *    quality-control pass on our own maintenance work, or green-pool visits
 *    bootstrapping a pool that already has a maintenance agreement. riderOf
 *    names the host; ending the host ends its riders.
 */

import type { Program } from "../../../external/ion/task-translation"
export type { Program }

export type Basis =
  | { kind: "customer_contract"; program: Program }
  | { kind: "rider"; program: "quality_control" | "green_to_clean"; riderOf: string }
