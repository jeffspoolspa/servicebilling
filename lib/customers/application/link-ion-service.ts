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

import type { Customer, CustomerRepository, ExternalCustomerDirectory } from "@/lib/customers/domain"

export interface LinkReport {
  linked: { accountId: number; displayName: string; ionCustId: string; confidence: string }[]
  ambiguous: { accountId: number; displayName: string; candidates: { ionCustId: string; rowText: string }[] }[]
  notFound: { accountId: number; displayName: string; attempts: number; exhausted: boolean }[]
}

export class LinkIonService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly directory: ExternalCustomerDirectory,
  ) {}

  /** Every customer still owed an attempt — the daily sweep's entry point. */
  async linkDue(now: Date, opts: { dryRun: boolean }): Promise<LinkReport> {
    return this.linkThese(await this.customers.dueForIonLink(now), opts)
  }

  /** Named customers — the button's entry point, no waiting-window check. */
  async link(accountIds: number[], opts: { dryRun: boolean }): Promise<LinkReport> {
    return this.linkThese(await this.customers.awaitingIon(accountIds), opts)
  }

  private async linkThese(awaiting: Customer[], opts: { dryRun: boolean }): Promise<LinkReport> {
    const report: LinkReport = { linked: [], ambiguous: [], notFound: [] }

    for (const c of awaiting) {
      const match = await this.directory.identify(c)
      const accountId = Number(c.id)
      if (match.kind === "linked") {
        // The aggregate records the match (and refuses a re-fuzz); we save it.
        if (!opts.dryRun) await this.customers.save(c.linkIon({ ionCustId: match.id, method: match.method, confidence: match.confidence }))
        report.linked.push({ accountId, displayName: c.displayName, ionCustId: match.id, confidence: match.confidence })
      } else if (match.kind === "ambiguous") {
        report.ambiguous.push({ accountId, displayName: c.displayName, candidates: match.candidates.map((x) => ({ ionCustId: x.id, rowText: x.name })) })
      } else {
        // Not an error — ION has not synced them yet. Record the try; after
        // Customer.ION_LINK_TRIES the aggregate says a person should look.
        const tried = c.ionLinkAttempted()
        if (!opts.dryRun) await this.customers.save(tried)
        report.notFound.push({ accountId, displayName: c.displayName, attempts: (tried.ion as { attempts: number }).attempts, exhausted: tried.ionLinkExhausted })
      }
    }
    return report
  }
}
