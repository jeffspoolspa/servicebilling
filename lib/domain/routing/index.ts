/**
 * Routing domain — pure. Imports nothing outside this folder.
 *
 * Five mechanics hold this together; a change that breaks one is a change to
 * the model, not a refactor:
 *   1. the Quota aggregate is the only place a Stop is formed or changed
 *   2. one write pattern everywhere: compute desired, diff, apply
 *   3. events for latency, sweeps for truth
 *   4. shared facts stored once, re-attached on read
 *   5. store decisions and facts; compute everything else
 */

export * from "./policy"
export * from "./values"
export * from "./events"
export * from "./quota"
export * from "./geometry"
export * from "./matrix"
export * from "./cost"
export * from "./optimizer"
export * from "./planner"
export * from "./route-factory"
export * from "./scenario"
export * from "./serialization"
export * from "./ports"
