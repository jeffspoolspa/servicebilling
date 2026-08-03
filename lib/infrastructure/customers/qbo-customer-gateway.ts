/**
 * BillingDirectory over the app's sanctioned QBO writer (createInQbo:
 * pending-mark, Windmill create with idempotency key, qbo_customer_id stamp,
 * webhook-expectation WAL). This file owns the translation of a draft into
 * QBO's vocabulary; nothing above it knows a QBO field name.
 */

import { createInQbo } from "@/lib/qbo/write"
import type { BillingDirectory } from "@/lib/application/customers/onboarding-service"
import type { CustomerDraft } from "@/lib/domain/customers/customer"

export class QboCustomerGateway implements BillingDirectory {
  async ensureCustomer(accountId: number, draft: CustomerDraft): Promise<"created" | "deferred"> {
    const s = draft.shape
    const body: Record<string, unknown> = {
      DisplayName: `${s.lastName}, ${s.firstName}`.trim(),
      GivenName: s.firstName,
      FamilyName: s.lastName,
      Notes: draft.profile.notes.join(" | ").slice(0, 4000),
      BillAddr: {
        Line1: s.street,
        City: s.city,
        CountrySubDivisionCode: s.state,
        PostalCode: s.zip,
      },
    }
    if (s.email) body.PrimaryEmailAddr = { Address: s.email }
    if (s.phone) body.PrimaryPhone = { FreeFormNumber: s.phone }
    try {
      const r = await createInQbo("customer", body, { localId: accountId })
      return r.success ? "created" : "deferred"
    } catch {
      return "deferred" // the expectation WAL + CDC reconciler repair later
    }
  }
}
