/**
 * The shared kernel — the GRAMMAR every bounded context builds its model
 * from. No business vocabulary lives here, ever: no wallet, no invoice, no
 * customer. Entry test for a seventh member (all three required):
 * domain-meaningless machinery · needed by 2+ contexts · frozen once written.
 *
 * Members: Entity, AggregateRoot, DomainEvent, UnitOfWork, AggregateRepository,
 * WriteOut.
 */

/**
 * A domain fact, as billing.events records it (EVENT_VOCABULARY.md):
 * full-change payload, one fact per change, replay-dedupable.
 */
export interface DomainEvent {
  readonly type: string
  readonly payload: Record<string, unknown>
  /** Aggregate ids this fact touches beyond its own — "pm:…", "customer:…". */
  readonly participants: readonly string[]
  /** ISO moment the decision was made (the aggregate's clock, not the DB's). */
  readonly at: string
}

/**
 * Something with identity: two instances with the same id ARE the same thing,
 * whatever their fields say (a Wallet re-read after a refresh is still THAT
 * wallet). Value objects are the opposite — compared by contents — and get no
 * base class; a plain readonly object is already one.
 */
export abstract class Entity<Id> {
  constructor(readonly id: Id) {}
  equals(other: Entity<Id>): boolean {
    return other.constructor === this.constructor && other.id === this.id
  }
}

/**
 * The root of a consistency boundary: the one entity through which every
 * change to its cluster flows, and the unit a repository loads and saves.
 * Decisions record() facts; the repository publishes them in the SAME
 * transaction as the state (see AggregateRepository) — that pairing is what
 * makes "the event log is the source of truth" structurally true instead of
 * a convention.
 */
export abstract class AggregateRoot<Id> extends Entity<Id> {
  #events: DomainEvent[] = []
  protected record(event: DomainEvent): void {
    this.#events.push(event)
  }
  /** Drains: the repository takes the facts exactly once, at save. */
  pullEvents(): DomainEvent[] {
    const events = this.#events
    this.#events = []
    return events
  }
}

/**
 * A database transaction handle — an OPAQUE MARKER here (RULED 2026-08-06:
 * Kysely + codegen; the kernel stays dependency-free, so it cannot name
 * Kysely's type). Infrastructure narrows this to Kysely's Transaction<DB>;
 * repositories thread it; the domain never sees it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Tx {}

/**
 * Unit of Work — atomic commit as an object: everything inside execute()
 * becomes visible all at once, or not at all. Policy (ours, not the
 * pattern's): ONE aggregate per unit, plus its facts and purely mechanical
 * companions (queue envelopes). A second aggregate in the same unit is a
 * design smell — the reaction belongs to an event handler in its own unit.
 */
export interface UnitOfWork {
  execute<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

/**
 * The "one breath" rule, written once: state and facts commit together.
 * Concrete repositories implement ONLY the row mapping; they cannot forget
 * to publish events or split the transaction, because this class won't let
 * them. publishEvents is also implemented once (infrastructure subclass) —
 * billing.events lives in the same database as the state, which is what
 * makes the fact and the change share a commit (no dual-write seam).
 */
export abstract class AggregateRepository<A extends AggregateRoot<unknown>> {
  constructor(protected readonly uow: UnitOfWork) {}

  async save(aggregate: A): Promise<void> {
    const events = aggregate.pullEvents()
    await this.uow.execute(async (tx) => {
      await this.persist(aggregate, tx)
      await this.publishEvents(aggregate, events, tx)
    })
  }

  /** The mapping: aggregate → rows. The ONLY thing a concrete repo writes. */
  protected abstract persist(aggregate: A, tx: Tx): Promise<void>
  /** Event-store INSERT — one shared implementation in infrastructure. */
  protected abstract publishEvents(aggregate: A, events: DomainEvent[], tx: Tx): Promise<void>
}

/**
 * WriteOut — one effect on an external system (ADR 001's [write-out] edge),
 * as three phases and TWO transactions. House name; lineage: composite of
 * write-ahead logging + idempotency key + transactional outbox — equivalent
 * to a Temporal/DBOS durable step/activity.
 *
 * The seam between tx1 and tx2 is NOT transactional (no BEGIN spans us and
 * Intuit); the idempotency key bridges it. Hence the two laws this class
 * makes unbreakable:
 *   1. Intent is durable BEFORE the effect fires (else a crash leaves an
 *      effect nobody knows to ask about).
 *   2. performOrResume must query-before-retry on a found prior — "unknown"
 *      is a state to resolve by asking the leader, never by re-firing.
 * recordOutcome converges the cache from the ECHO (ADR 012's verified
 * proof), never from assuming the request worked.
 */
export abstract class WriteOut<TIntent, TResult, TOutcome> {
  constructor(protected readonly uow: UnitOfWork) {}

  async run(intent: TIntent): Promise<TOutcome> {
    const recorded = await this.uow.execute((tx) => this.recordIntent(intent, tx)) // tx1
    const result = await this.performOrResume(recorded)                            // no tx
    return this.uow.execute((tx) => this.recordOutcome(recorded, result, tx))      // tx2
  }

  /** tx1: WAL the intent + mint/persist the idempotency key. */
  protected abstract recordIntent(intent: TIntent, tx: Tx): Promise<IntentRecord<TIntent>>
  /** The external call, keyed. A found prior MUST be resolved by querying the leader. */
  protected abstract performOrResume(recorded: IntentRecord<TIntent>): Promise<TResult>
  /** tx2: outcome + echo→cache convergence + fact, one commit. */
  protected abstract recordOutcome(
    recorded: IntentRecord<TIntent>,
    result: TResult,
    tx: Tx,
  ): Promise<TOutcome>
}

/** The durable half of a WriteOut: what tx1 persisted, incl. the key. */
export interface IntentRecord<TIntent> {
  readonly intentId: string
  readonly idempotencyKey: string
  readonly intent: TIntent
}
