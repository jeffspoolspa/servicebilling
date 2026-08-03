/**
 * Maintenance domain — pure. Imports nothing outside this folder.
 *
 * The billing half of this module is modelled in
 *   docs/model/BILLING_MODEL.md   (worksheet — aggregates, invariants and
 *   where domain events fit)
 *
 * This index is the module's PUBLISHED CONTRACT: everything above the domain
 * imports from here, never from a file inside.
 *
 * The spine this module owns: lead -> ServiceAgreement -> Task -> visits.
 * An agreement is what we PROMISED (cadence, rate, pool, access); a task is
 * that promise made real in ION and billable. The agreement is constructed
 * only from a RESOLVED cadence, so an ambiguity can never travel downstream
 * disguised as a schedule.
 *
 * It references the customers domain by id only — never by object graph.
 */

export * from "./billing-terms"
export * from "./task"
export * from "./service-agreement"
export * from "./ports"
