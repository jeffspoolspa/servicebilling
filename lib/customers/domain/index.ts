/**
 * Customers domain — pure. Imports nothing outside this folder.
 *
 * This index is the module's PUBLISHED CONTRACT: everything above the domain
 * imports from here, never from a file inside. Three mechanics hold it
 * together; a change that breaks one is a change to the model, not a refactor:
 *
 *   1. every field is PARSED into a value object, never merely checked —
 *      holding a Phone is proof it is a phone
 *   2. one parser, two doors: the same failure refuses outbound
 *      (Customer.draft) and flags inbound (Customer.rehydrate), because QBO
 *      is the leader and its records may never be rejected
 *   3. progress is DERIVED from the two external refs, never a status column
 *
 * What is deliberately NOT here: service terms (cadence, rate, pool) — those
 * are a ServiceAgreement in the maintenance domain. Customers must never
 * depend on Maintenance.
 */

export * from "./values"
export * from "./customer"
export * from "./ports"
