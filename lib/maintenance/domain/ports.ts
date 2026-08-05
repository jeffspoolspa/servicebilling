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
  /**
   * What the system of record ALREADY holds for this contract.
   *
   * A supersede is two irreversible steps — end one agreement, begin another —
   * and a retry that repeats either is worse than the failure it retries:
   * creating twice leaves the customer holding two live contracts. So the
   * operation asks what landed before it acts.
   *
   * Optional because an in-memory gateway has nothing to resume from; a
   * supersede REFUSES when it is absent rather than acting blind, the same way
   * it refuses without a freshness source.
   *
   * Takes only the record's own id: finding the customer that owns it, and
   * their other contracts, is the adapter's vocabulary and not the model's.
   */
  inspect?(ionTaskId: string): Promise<{
    /** The end date the record currently carries, if any. */
    endsOn: string | null
    /** Its anchor, to prove we are looking at the contract we think we are. */
    startsOn: string | null
    /** Sibling contracts for the same customer, by anchor. */
    siblings: { ionTaskId: string; startsOn: string | null }[]
  }>
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

/**
 * Make our copy of a task true before anything is computed FROM it.
 *
 * Not optional for a supersede: the effective week and the successor's anchor
 * are derived from the CURRENT contract, so a stale row silently produces a
 * wrong date. Proven 2026-08-05 on Bayens — our cache held starts_on
 * 2025-01-03 with no live cadence, while ION held 2024-12-30 Bi-Weekly.
 *
 * A port because refreshing is I/O the model must not do, and because
 * PublishService already treats refresh as a required precondition; editTask
 * had simply been trusting the cache.
 */
/** The whole servicing state of a task — what an edit is measured against. */
export interface TaskServicingState {
  /** weekday -> tech: the servicing map. */
  days: Record<string, string | null>
  frequency: string | null
  startsOn: string | null
  /** Set means the task is over. An expiry is an end date, not a separate kind. */
  endsOn: string | null
}

/**
 * One task, before and after. NOT one entry per field: a day moving, a tech
 * swapping, a cadence changing and a task expiring are four ways the same
 * state differs, not four kinds of event to categorise. Recording the whole
 * state twice keeps the history readable without a taxonomy that has to grow
 * every time ION grows a field.
 */
export interface TaskStateChange {
  taskId: string
  before: TaskServicingState
  after: TaskServicingState
}

export interface FreshnessSource {
  /**
   * Reconcile these tasks with the system of record. Returns those it
   * verified, and every disagreement it corrected — old value and new — so
   * the caller can record what an outside edit changed. An adapter never
   * writes that history itself: the same correction means different things
   * depending on why it was made.
   */
  refresh(taskIds: readonly string[]): Promise<{
    verified: string[]
    skipped: { taskId: string; reason: string }[]
    drift?: TaskStateChange[]
  }>
}

/**
 * Which tasks a customer actually has in ION, right now.
 *
 * The ONLY way to notice a task deleted outside our system: a task we hold
 * that ION no longer lists is gone. Visits cannot tell us — a deleted task
 * simply stops producing them, which is indistinguishable from a pool closed
 * for winter until months have passed.
 */
export interface TaskRoster {
  /**
   * ION task ids for this customer, keyed by OUR customer id — the adapter
   * owns the translation, so the model never learns ION's vocabulary.
   * Throws rather than returning empty on failure: an empty set would read as
   * "every task deleted".
   */
  idsFor(customerId: number): Promise<Set<string>>
}
