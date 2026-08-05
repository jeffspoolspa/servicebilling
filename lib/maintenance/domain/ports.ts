/**
 * What the maintenance domain needs from the outside, as interfaces it owns.
 *
 * Infrastructure implements these; the domain never imports infrastructure.
 * Two different kinds of collaborator live here, and the names are deliberate:
 *
 *   Repository — pretends to be memory. Holds OUR aggregates in OUR store,
 *                reconstitutes what was already valid, and appends whatever the
 *                aggregate recorded. save/byId semantics.
 *   Gateway    — crosses a border. Translates our vocabulary into a foreign
 *                system's (ION) and can refuse, time out, or reject terms we
 *                think are fine. Never pretend this is a collection.
 *
 * Conflating them is how a network call ends up being treated like a hash-map
 * write, so they stay apart even though both are "the outside".
 */

import type { Task, TaskEvent, DesiredWeek } from "./task"

export interface TaskRepository {
  byId(taskId: string): Promise<Task | null>
  /**
   * The open (active or paused) task at this customer, if any. The database
   * allows only one, so a second service that charges differently is a second
   * task — the caller decides what to do about that, not this port.
   */
  openTaskFor(customerId: number): Promise<Task | null>
  /** Persist the task and append whatever it recorded, in one breath. */
  save(task: Task): Promise<void>
  /** The task's history, oldest first — audit and verification, not state. */
  history(taskId: string): Promise<TaskEvent[]>
}

/** What came back from the system of record after a write. */
export interface GatewayResult {
  readonly accepted: boolean
  /** Present after a successful create — the identity ION minted. */
  readonly ionTaskId?: string
  readonly detail: string
  /** The exact payload sent (or that would be sent on a dry run). */
  readonly payload?: Record<string, string>
}

/**
 * The system of record for tasks. Create and update are separate operations
 * because their preconditions differ — a create has no id to address and can
 * only be verified by what comes back, an update names an existing task and
 * must not invent one. That they happen to share a form on ION's side is the
 * ADAPTER's business, not this contract's.
 */
export interface TaskGateway {
  create(week: DesiredWeek, opts: { dryRun: boolean }): Promise<GatewayResult>
  update(ionTaskId: string, week: DesiredWeek, opts: { dryRun: boolean }): Promise<GatewayResult>
  /**
   * Set a task's start date — the anchor that, for non-weekly cadences, encodes
   * BOTH the serviced weekday and the alternating-week parity. Works in either
   * direction (the system of record guards backdates behind a side channel the
   * adapter knows about; callers never do). Verified by read-back, not by the
   * write's status code.
   */
  changeStartDate(
    ionTaskId: string,
    customerId: number,
    date: string,
    opts: { dryRun: boolean },
  ): Promise<GatewayResult>
}

/** Prices that live in the foreign catalog, not in our contract. */
export interface ServiceCatalog {
  /** The catalog price for a service type, used when no explicit price is set. */
  priceCents(serviceTypeId: string): number | null
}

/**
 * When a task was last actually serviced.
 *
 * A revision needs this to choose its effective week — the current week is
 * still available unless its visit already happened. It is a PORT because the
 * answer lives outside the model: ION's own record for the task, which is
 * authoritative for what ION will generate next.
 *
 * Kept separate from TaskGateway on purpose: this is a read about SERVICE
 * DELIVERY, not about the contract, and a caller that only needs the date
 * should not have to hold a gateway that can write.
 */
export interface LastVisitSource {
  /** ISO date of the most recent completed visit, or null if never serviced. */
  lastVisitFor(ionTaskId: string): Promise<string | null>
}
