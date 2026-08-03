/**
 * The Customer aggregate: who someone is to us, and how far along the two
 * external systems are at agreeing they exist.
 *
 * Two doors, one set of rules. Everything WE create is parsed by the factory,
 * which refuses on a blocking violation. Customers born directly in QBO
 * cannot be refused — QBO is the leader — so the identical parse runs after
 * the fact and its failures are carried as VIOLATIONS on the customer. That
 * is why violations are state here and not the return value of a separate
 * draft object: a flagged customer is a real customer that breaks our rules.
 *
 * What is NOT here:
 *  - the SERVICE address — that is the ServiceLocation entity (also in this
 *    domain: it is where the customer's pool is, and it exists whether or not
 *    anyone services it), identified by its rooftop place id. Maintenance
 *    only REFERENCES it by that id.
 *  - anything about pools, cadence or rates — those are the terms of a
 *    service agreement (maintenance module). A billing-only customer has
 *    none of them, and Customers must never depend on Maintenance.
 */

import { BillingAddress, Email, holdsSeveral, PersonName, Phone } from "./values"

/* ----------------------------- external refs ------------------------------ */

/** A deferred reference into another system. The durable form of a promise. */
export type ExternalRef =
  | { state: "unlinked" }
  | { state: "awaiting"; since: string; attempts: number }
  | { state: "linked"; id: string; method: string; confidence: string; at: string }
  | { state: "ambiguous"; candidates: { id: string; name: string }[] }

/** ADR 006's four columns, read as one meaning. */
export function ionRefFrom(row: {
  ion_cust_id: string | null
  ion_match_method: string | null
  ion_match_confidence: string | null
  ion_matched_at: string | null
}): ExternalRef {
  if (!row.ion_cust_id) return { state: "unlinked" }
  return {
    state: "linked",
    id: row.ion_cust_id,
    method: row.ion_match_method ?? "unknown",
    confidence: row.ion_match_confidence ?? "unknown",
    at: row.ion_matched_at ?? "",
  }
}

/* -------------------------------- violations ------------------------------ */

export interface Violation {
  rule: string
  detail: string
  /** blocking = we refuse to create; advisory = flagged, work proceeds. */
  blocking: boolean
}

/* --------------------------------- input ---------------------------------- */

/** Raw contact fields, from a sheet row, a form, a lead, or a QBO webhook. */
export interface CustomerInput {
  name: string
  street: string
  city: string
  state?: string
  zip: string
  phone: string
  email: string
}

export type OnboardingState = "drafted" | "billing_linked" | "awaiting_ion" | "linked" | "ambiguous"

/* ------------------------------- the aggregate ---------------------------- */

export class Customer {
  private constructor(
    readonly id: string | null,
    readonly name: PersonName,
    readonly billing: BillingAddress,
    readonly phone: Phone | null,
    readonly email: Email | null,
    readonly violations: Violation[],
    readonly qbo: ExternalRef = { state: "unlinked" },
    readonly ion: ExternalRef = { state: "unlinked" },
  ) {}

  /**
   * The factory. Parses every field into its value object and collects what
   * failed. Returns either a Customer (possibly carrying advisories) or the
   * blocking reasons — never a half-built object, and never a bag of strings
   * pretending to be a customer.
   */
  static draft(input: CustomerInput): Customer | { refused: Violation[] } {
    const v: Violation[] = []

    const name = PersonName.parse(input.name)
    if (name === "invalid") v.push({ rule: "name", detail: `"${input.name}" is not a first and last name`, blocking: true })

    const billing = BillingAddress.parse(input)
    if (billing === "invalid") {
      v.push({
        rule: "billing-address",
        // City is blocking because geocoding without one pins the wrong town
        // (ADR 007) — the defect that put customers in the wrong city.
        detail: `incomplete address (street, city and 5-digit zip are all required): ${input.street}, ${input.city} ${input.zip}`,
        blocking: true,
      })
    }

    const phone = Phone.parse(input.phone)
    if (phone === "invalid") v.push({ rule: "phone", detail: `"${input.phone}" is not a 10-digit number`, blocking: false })
    else if (holdsSeveral(input.phone)) v.push({ rule: "phone", detail: `several numbers listed — using the first (${(phone as Phone).display})`, blocking: false })

    const email = Email.parse(input.email)
    if (email === "invalid") v.push({ rule: "email", detail: `"${input.email}" is not a valid address`, blocking: false })
    else if (email !== null && holdsSeveral(input.email)) v.push({ rule: "email", detail: `several addresses listed — using the first (${(email as Email).address})`, blocking: false })

    const gotPhone = phone !== null && phone !== "invalid"
    const gotEmail = email !== null && email !== "invalid"
    if (!gotPhone && !gotEmail) v.push({ rule: "contact", detail: "no usable phone and no usable email — unreachable", blocking: true })
    else if (!gotEmail) v.push({ rule: "email", detail: "no email — invoices go by mail or SMS only", blocking: false })

    const blocking = v.filter((x) => x.blocking)
    if (blocking.length > 0) return { refused: blocking }

    return new Customer(
      null,
      name as PersonName,
      billing as BillingAddress,
      gotPhone ? (phone as Phone) : null,
      gotEmail ? (email as Email) : null,
      v,
    )
  }

  /**
   * The INBOUND door: a customer that already exists (born in QBO, or read
   * back from our cache). Never refuses — unparseable fields become
   * violations, because we do not get to reject the leader's records.
   */
  static rehydrate(
    id: string,
    input: CustomerInput,
    refs: { qbo: ExternalRef; ion: ExternalRef },
  ): Customer {
    const drafted = Customer.draft(input)
    if (drafted instanceof Customer) {
      return new Customer(id, drafted.name, drafted.billing, drafted.phone, drafted.email, drafted.violations, refs.qbo, refs.ion)
    }
    // Flagged, not refused: keep whatever parsed, carry the rest as findings.
    const name = PersonName.parse(input.name)
    const billing = BillingAddress.parse(input)
    const phone = Phone.parse(input.phone)
    const email = Email.parse(input.email)
    return new Customer(
      id,
      name === "invalid" ? PersonName.parse("UNPARSEABLE NAME") as PersonName : name,
      billing === "invalid" ? BillingAddress.parse({ street: "-", city: "-", zip: "00000" }) as BillingAddress : billing,
      phone === "invalid" || phone === null ? null : phone,
      email === "invalid" || email === null ? null : email,
      drafted.refused,
      refs.qbo,
      refs.ion,
    )
  }

  get displayName(): string {
    return this.name.displayName
  }

  get flagged(): boolean {
    return this.violations.some((v) => v.blocking)
  }

  /** Progress is DERIVED from the refs — never a stamped status column. */
  get onboarding(): OnboardingState {
    if (this.ion.state === "linked") return "linked"
    if (this.ion.state === "ambiguous") return "ambiguous"
    if (this.qbo.state === "linked") return "awaiting_ion"
    if (this.id !== null) return "billing_linked"
    return "drafted"
  }

  /** Why an action is not available yet — null when it is. [I-C3] */
  blocks(action: "create_task"): string | null {
    if (action === "create_task" && this.ion.state !== "linked") {
      return `cannot create an ION task: this customer's ION link is ${this.ion.state}`
    }
    return null
  }

  withIds(id: string, refs: { qbo?: ExternalRef; ion?: ExternalRef } = {}): Customer {
    return new Customer(id, this.name, this.billing, this.phone, this.email, this.violations, refs.qbo ?? this.qbo, refs.ion ?? this.ion)
  }
}
