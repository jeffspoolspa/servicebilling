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
import type { CustomerRepository } from "@/lib/customers/domain"

export interface LinkReport {
  linked: { accountId: number; displayName: string; ionCustId: string; confidence: string }[]
  ambiguous: { accountId: number; displayName: string; candidates: { ionCustId: string; rowText: string }[] }[]
  notFound: { accountId: number; displayName: string }[]
}

export class LinkIonService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly ion: IonCustomers,
  ) {}

  async link(accountIds: number[], opts: { dryRun: boolean }): Promise<LinkReport> {
    const awaiting = await this.customers.awaitingIon(accountIds)
    const report: LinkReport = { linked: [], ambiguous: [], notFound: [] }

    for (const c of awaiting) {
      const rows = await this.ion.search(c.name.last || c.displayName)
      const match = matchIonCustomer({ firstName: c.name.first, lastName: c.name.last, street: c.billing.street }, rows)
      const accountId = Number(c.id)
      if (match.kind === "linked") {
        // The aggregate records the match (and refuses a re-fuzz); we save it.
        if (!opts.dryRun) await this.customers.save(c.linkIon({ ionCustId: match.ionCustId, method: "api_fuzzy", confidence: match.confidence }))
        report.linked.push({ accountId, displayName: c.displayName, ionCustId: match.ionCustId, confidence: match.confidence })
      } else if (match.kind === "ambiguous") {
        report.ambiguous.push({ accountId, displayName: c.displayName, candidates: match.candidates })
      } else {
        report.notFound.push({ accountId, displayName: c.displayName })
      }
    }
    return report
  }
}
