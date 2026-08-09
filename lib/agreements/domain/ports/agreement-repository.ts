import type { ServiceAgreement } from "../service-agreement/service-agreement"

/** The aggregate's door. Hydration derives; save is one breath (kernel). */
export interface AgreementRepository {
  byId(id: string): Promise<ServiceAgreement | null>
  /** Ledger period lookup: which agreement did this ION id belong to ON this
   *  date — the ingest-time visit stamper and the refresh both ask this. */
  byIonTaskId(ionTaskId: string, onDate: string): Promise<ServiceAgreement | null>
  byCustomer(customerId: string): Promise<ServiceAgreement[]>
  save(agreement: ServiceAgreement): Promise<void>
}
