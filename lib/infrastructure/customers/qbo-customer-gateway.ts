/**
 * BillingDirectory over the Qbo object (ADR 012). The create's VERIFIED ECHO
 * — QBO's response carrying the new customer's Id — fulfills the promise
 * synchronously, and the id is stamped onto our row in the same breath
 * (row-count asserted). No expectation row: there is nothing to wait for.
 */

import { QboCustomers } from "@/lib/infrastructure/qbo/qbo"
import type { BillingDirectory } from "@/lib/application/customers/onboarding-service"
import type { CustomerDraft } from "@/lib/domain/customers/customer"

interface Stamper {
  from(t: string): {
    update(v: Record<string, unknown>): {
      eq(c: string, v: unknown): { select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }
  }
}

export class QboCustomerGateway implements BillingDirectory {
  constructor(
    private readonly qbo: QboCustomers,
    private readonly db: Stamper,
  ) {}

  async ensureCustomer(accountId: number, draft: CustomerDraft): Promise<"created" | "deferred"> {
    const s = draft.shape
    try {
      const r = await this.qbo.createCustomer({
        displayName: `${s.lastName}, ${s.firstName}`.trim(),
        givenName: s.firstName,
        familyName: s.lastName,
        street: s.street,
        city: s.city,
        state: s.state,
        zip: s.zip,
        email: s.email,
        phone: s.phone,
        notes: draft.profile.notes.join(" | "),
      })
      const { data, error } = await this.db
        .from("Customers")
        .update({ qbo_customer_id: r.qboId })
        .eq("id", accountId)
        .select("id")
      if (error) throw new Error(`qbo_customer_id stamp failed: ${JSON.stringify(error).slice(0, 200)}`)
      if (!data || data.length === 0) {
        throw new Error(`qbo_customer_id stamp touched NO rows (account ${accountId}) — filtered, not applied`)
      }
      return "created"
    } catch (err) {
      // Deferred is honest: the account exists, the QBO id does not — a re-run
      // converges (duplicate-name resolves to the existing QBO customer).
      console.error(`QBO ensure failed for ${draft.displayName}: ${err instanceof Error ? err.message : err}`)
      return "deferred"
    }
  }
}
