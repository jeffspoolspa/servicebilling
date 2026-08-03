/**
 * What the customers domain needs implemented, stated in ITS OWN words.
 *
 * A Repository pretends to be an in-memory collection of aggregates: you ask
 * it for a Customer and you get a Customer — not a row, not a DTO. That is
 * the difference between a Repository and a table gateway, and it is what
 * lets the application layer speak the ubiquitous language end to end
 * (`customer.linkIon(match)` then `save(customer)`, never
 * `update(id, {ion_cust_id, ion_match_method, ...})`).
 *
 * Infrastructure implements these; the domain imports nothing to do it.
 */

import type { Customer } from "./customer"

/** The identity of a place the truck visits — its rooftop place id. */
export interface PlaceIdentity {
  placeId: string
  street: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
}

export interface CustomerRepository {
  /**
   * The identity lookup: one rooftop names one service location, which names
   * one account. Exact — no normalization, no guessing.
   */
  byPlaceId(placeId: string): Promise<Customer | null>

  /** The fallback for addresses no geocoder could pin. */
  byStreet(street: string): Promise<Customer | null>

  /** Reconstitute several at once, for a batch that must not N+1. */
  byIds(ids: readonly number[]): Promise<Map<number, Customer>>

  /**
   * Add a customer we have never seen, through the canonical account door.
   * Returns the customer reconstituted WITH its new id.
   */
  add(customer: Customer, place: PlaceIdentity | null): Promise<Customer>

  /**
   * Persist the changes an aggregate is carrying — today that is its external
   * references. Asserts it touched a row: a filtered write reports success.
   */
  save(customer: Customer): Promise<void>

  /** Customers whose billing identity exists but whose ION link does not. */
  awaitingIon(ids: readonly number[]): Promise<Customer[]>
}

/**
 * What another system says this customer is, in OUR words. The application
 * layer never learns which system, how it is searched, or what its rows look
 * like — that is the anticorruption layer's business.
 */
export type CustomerMatch =
  | { kind: "linked"; id: string; method: string; confidence: string }
  | { kind: "ambiguous"; candidates: { id: string; name: string }[] }
  | { kind: "not_found" }

/** Resolve a customer's identity in an external system (today: ION). */
export interface ExternalCustomerDirectory {
  identify(customer: Customer): Promise<CustomerMatch>
}
