/**
 * The customers module's ANTICORRUPTION LAYER for ION.
 *
 * It implements a port the DOMAIN declared (ExternalCustomerDirectory), so
 * the application service asks "who is this customer in the other system?"
 * in our words and never learns that ION exists, that it is searched by
 * surname, or that its rows are HTML.
 *
 * The matching rule is ADR 006's, measured on 683 known pairs (98% match on
 * normalized name exactly). Ambiguity is surfaced, never guessed.
 */

import type { Customer, CustomerMatch, ExternalCustomerDirectory } from "@/lib/customers/domain"
import type { IonCustomers } from "@/lib/external/ion/ion"

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** ION's list rows -> a link decision. Pure judgment over fetched rows. */
export function matchIonCustomer(
  target: { firstName: string; lastName: string; street: string },
  rows: { ionCustId: string; rowText: string }[],
): CustomerMatch {
  const nameKey = alnum(`${target.lastName}${target.firstName}`)
  const nameKeyFlip = alnum(`${target.firstName}${target.lastName}`)
  const byName = rows.filter((r) => {
    const t = alnum(r.rowText)
    return t.includes(nameKey) || t.includes(nameKeyFlip)
  })
  if (byName.length === 0) return { kind: "not_found" }

  const streetKey = alnum(target.street.split(/\s+/).slice(0, 2).join(""))
  const byStreet = streetKey ? byName.filter((r) => alnum(r.rowText).includes(streetKey)) : []

  if (byName.length === 1) {
    return { kind: "linked", id: byName[0].ionCustId, method: "api_fuzzy", confidence: byStreet.length === 1 ? "high" : "medium" }
  }
  if (byStreet.length === 1) return { kind: "linked", id: byStreet[0].ionCustId, method: "api_fuzzy", confidence: "high" }
  return { kind: "ambiguous", candidates: byName.map((r) => ({ id: r.ionCustId, name: r.rowText.slice(0, 120) })) }
}

export class IonCustomerDirectory implements ExternalCustomerDirectory {
  constructor(private readonly ion: IonCustomers) {}

  async identify(customer: Customer): Promise<CustomerMatch> {
    // ION's search matches a single term best, so we hand it the surname and
    // judge the candidate rows ourselves.
    const rows = await this.ion.search(customer.name.last || customer.displayName)
    return matchIonCustomer(
      { firstName: customer.name.first, lastName: customer.name.last, street: customer.billing.street },
      rows,
    )
  }
}
