/**
 * Resolve ION customer ids — the second leg of onboarding, on its own clock.
 *
 * OnboardingService ends with the customer AWAITING ION: the id does not
 * exist anywhere until the QBO -> ION sync (ProEdge) runs. This service is
 * the durable other half of that promise: take the awaiting customers, search
 * ION by surname, let the ACL judge the rows (ADR 006's measured rules), and
 * persist a link ONCE — fuzzy-match-once-and-persist, never re-fuzzed.
 * Ambiguity is surfaced for a human, never guessed. Not-found is a normal
 * state: the sync just hasn't run yet, and the next pass retries.
 *
 * Retriable and idempotent by construction — safe on a queue, a cron, a
 * button, or a script.
 */

import { matchIonCustomer } from "@/lib/external/ion/acl"
import type { IonCustomers } from "@/lib/external/ion/ion"
import type { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"

export interface LinkReport {
  linked: { accountId: number; displayName: string | null; ionCustId: string; confidence: string }[]
  ambiguous: { accountId: number; displayName: string | null; candidates: { ionCustId: string; rowText: string }[] }[]
  notFound: { accountId: number; displayName: string | null }[]
}

export class LinkIonService {
  constructor(
    private readonly customers: SupabaseCustomerRepository,
    private readonly ion: IonCustomers,
  ) {}

  async link(accountIds: number[], opts: { dryRun: boolean }): Promise<LinkReport> {
    const awaiting = await this.customers.awaitingIon(accountIds)
    const report: LinkReport = { linked: [], ambiguous: [], notFound: [] }

    for (const c of awaiting) {
      const rows = await this.ion.search(c.lastName || c.displayName || "")
      const match = matchIonCustomer({ firstName: c.firstName, lastName: c.lastName, street: c.street }, rows)
      if (match.kind === "linked") {
        if (!opts.dryRun) await this.customers.linkIon(c.accountId, match.ionCustId, "api_fuzzy", match.confidence)
        report.linked.push({ accountId: c.accountId, displayName: c.displayName, ionCustId: match.ionCustId, confidence: match.confidence })
      } else if (match.kind === "ambiguous") {
        report.ambiguous.push({ accountId: c.accountId, displayName: c.displayName, candidates: match.candidates })
      } else {
        report.notFound.push({ accountId: c.accountId, displayName: c.displayName })
      }
    }
    return report
  }
}
