/**
 * Customer value objects — PARSE, don't validate.
 *
 * A validator returns a boolean and throws away what it learned, so every
 * caller downstream has to trust that somebody checked. A parser returns a
 * more precise TYPE, and the knowledge survives in the type itself: once you
 * hold a Phone, it is a valid phone — there is no way to construct one that
 * isn't. Same discipline as Pin.fromTrusted in the routing domain.
 *
 * The parse RESULT is separate from the consequence, because the consequence
 * differs by door: outbound (we are creating) a failure refuses; inbound (a
 * customer born in QBO, which we may never reject) the identical failure is
 * flagged on the customer. One parser, two consequences.
 */

/**
 * A contact cell may hold SEVERAL values ("(978) 751-1245 / (347) 405-4406" —
 * a household with two people). The primary is the first; the rest are not an
 * error, they are extra. Splitting here keeps both doors honest: the sheet and
 * a QBO webhook can each hand us a crowded field.
 */
export const holdsSeveral = (raw: string | null | undefined) => /[,;/]|\s{2,}\S+@/.test((raw ?? "").trim())
const primaryOf = (raw: string | null | undefined) => ((raw ?? "").split(/[,;/]/)[0] ?? "").trim()

/* ---------------------------------- phone --------------------------------- */

/**
 * A North-American phone number in canonical form.
 *
 * Canonicalisation is load-bearing, not tidiness: ADR 006 matches an ION
 * customer to a QBO one on "name exact + PHONE AGREES", and agreement across
 * two systems is only decidable if both sides are reduced to the same digits.
 * The display form is what QBO stores (and it fits QBO's 21-char cap).
 */
export class Phone {
  private constructor(readonly digits: string) {}

  /** Ten digits, or null when absent. Anything else is a parse failure. */
  static parse(raw: string | null | undefined): Phone | null | "invalid" {
    const t = primaryOf(raw)
    if (!t) return null
    const d = t.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
    return d.length === 10 ? new Phone(d) : "invalid"
  }

  /** (912) 480-7453 — how QBO and humans read it. */
  get display(): string {
    return `(${this.digits.slice(0, 3)}) ${this.digits.slice(3, 6)}-${this.digits.slice(6)}`
  }

  equals(other: Phone | null): boolean {
    return other !== null && other.digits === this.digits
  }
}

/* ---------------------------------- email --------------------------------- */

/** An address we are willing to send an invoice to. Lower-cased, single. */
export class Email {
  private constructor(readonly address: string) {}

  static parse(raw: string | null | undefined): Email | null | "invalid" {
    // The primary address only — QBO takes one, and a cell holding three
    // addresses is what deferred 9 of the first 65 creates.
    const t = primaryOf(raw).toLowerCase()
    if (!t) return null
    if (/\s/.test(t)) return "invalid"
    return /^[^@]+@[^@.]+\.[^@]+$/.test(t) ? new Email(t) : "invalid"
  }
}

/* -------------------------------- addresses ------------------------------- */

/**
 * Where the invoice goes. A pure value — no identity, no row of its own: two
 * customers at the same billing address are not related by that fact.
 *
 * The SERVICE address is deliberately not here. It is an entity
 * (ServiceLocation) whose identity is its rooftop place id, because a service
 * address is a place the truck visits, and two customers at one place is a
 * tenancy question, not a coincidence.
 */
export class BillingAddress {
  private constructor(
    readonly street: string,
    readonly city: string,
    readonly state: string,
    readonly zip: string,
  ) {}

  static parse(a: { street: string; city: string; state?: string; zip: string }): BillingAddress | "invalid" {
    const street = a.street.trim()
    const city = a.city.trim()
    const state = (a.state ?? "GA").trim().toUpperCase()
    const zip = a.zip.trim().slice(0, 5)
    if (!street || !city || !/^\d{5}$/.test(zip) || state.length !== 2) return "invalid"
    return new BillingAddress(street, city, state, zip)
  }

  get oneLine(): string {
    return `${this.street}, ${this.city}, ${this.state} ${this.zip}`
  }
}

/* --------------------------------- naming --------------------------------- */

/** A person's name as we file it: "BROOKS, MARK". */
export class PersonName {
  private constructor(
    readonly first: string,
    readonly last: string,
  ) {}

  static parse(raw: string): PersonName | "invalid" {
    const n = raw.replace(/\s+/g, " ").trim()
    const cut = n.lastIndexOf(" ")
    if (cut <= 0) return "invalid"
    return new PersonName(n.slice(0, cut), n.slice(cut + 1))
  }

  get displayName(): string {
    return `${this.last.toUpperCase()}, ${this.first.toUpperCase()}`
  }
}
