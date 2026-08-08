/** Why the work exists. Billability is NOT decided here — it is a policy
 *  outcome at accrual (BillingMonth composes agreement terms × month policy
 *  × visit facts). basis carries the WHY and the rider cascade. */
export type Basis =
  | { kind: "customer_contract" }
  | { kind: "internal_program"; program: "qc"; riderOf: string | null }
