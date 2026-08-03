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

/**
 * ADR 006's four columns plus the attempt counters, read as ONE meaning.
 *
 * The distinction that matters: a customer with a billing identity but no ION
 * link is not "unlinked" (we never tried) — it is AWAITING (we are trying, a
 * bounded number of times). Those demand different actions, which is the
 * whole reason ExternalRef has four states instead of a nullable column.
 */
export function ionRefFrom(row: {
  ion_cust_id: string | null
  ion_match_method: string | null
  ion_match_confidence: string | null
  ion_matched_at: string | null
  ion_link_attempts?: number | null
  ion_link_attempted_at?: string | null
  qbo_customer_id?: string | null
}): ExternalRef {
  if (!row.ion_cust_id) {
    if (row.qbo_customer_id) {
      return { state: "awaiting", since: row.ion_link_attempted_at ?? "", attempts: row.ion_link_attempts ?? 0 }
    }
    return { state: "unlinked" }
  }
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

  /**
   * Record the billing identity QBO echoed back. The aggregate decides what a
   * fulfilled promise looks like; the repository only writes it down.
   */
  linkQbo(qboId: string, at = new Date().toISOString()): Customer {
    if (this.qbo.state === "linked" && this.qbo.id !== qboId) {
      throw new Error(`${this.displayName} is already QBO ${this.qbo.id}; refusing to relink to ${qboId}`)
    }
    return this.withIds(this.id ?? "", { qbo: { state: "linked", id: qboId, method: "create_echo", confidence: "high", at } })
  }

  /**
   * Record the ION match. Fuzzy-match ONCE and persist (ADR 006): a customer
   * already linked is never re-matched, because a second fuzz can disagree
   * with the first and we would have no way to tell which was right.
   */
  linkIon(match: { ionCustId: string; method: string; confidence: string }, at = new Date().toISOString()): Customer {
    if (this.ion.state === "linked") {
      throw new Error(`${this.displayName} is already ION ${this.ion.id} — matched once, never re-fuzzed`)
    }
    return this.withIds(this.id ?? "", {
      ion: { state: "linked", id: match.ionCustId, method: match.method, confidence: match.confidence, at },
    })
  }

  /**
   * How many tries we give ION's sync before a person has to look. Three
   * daily attempts: the sync is usually run the same day, and a customer
   * still missing after three days is missing for a reason.
   */
  static readonly ION_LINK_TRIES = 3

  /** Record a try that did not find them. The count is the give-up clock. */
  ionLinkAttempted(at = new Date().toISOString()): Customer {
    if (this.ion.state === "linked") return this
    const attempts = this.ion.state === "awaiting" ? this.ion.attempts + 1 : 1
    return this.withIds(this.id ?? "", { ion: { state: "awaiting", since: at, attempts } })
  }

  /** Tried enough. Not an error — a customer who needs a person. */
  get ionLinkExhausted(): boolean {
    return this.ion.state === "awaiting" && this.ion.attempts >= Customer.ION_LINK_TRIES
  }

  /**
   * Should the sweep try this one now? A customer is due when we are still
   * awaiting, have tries left, and have not tried within the window. The
   * BUTTON bypasses the window — a person clicking it is saying "I just
   * synced them", which is better information than a clock.
   */
  ionLinkDue(now: Date, windowHours = 20): boolean {
    if (this.ion.state !== "awaiting" || this.ionLinkExhausted) return false
    if (!this.ion.since) return true
    return now.getTime() - new Date(this.ion.since).getTime() >= windowHours * 3_600_000
  }

  /** Several plausible ION matches and no tie-break — a person decides. */
  ionIsAmbiguous(candidates: { id: string; name: string }[]): Customer {
    return this.withIds(this.id ?? "", { ion: { state: "ambiguous", candidates } })
  }
}
