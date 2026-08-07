import { AggregateRepository, type AggregateRoot, type DomainEvent, type Tx } from "@/lib/domain/kernel"
import { asDb } from "./kysely"

/**
 * The infrastructure half of the one-breath rule: WHAT publishing an event
 * means — an INSERT into billing.events, shaped per EVENT_VOCABULARY.md —
 * written once, here. The kernel enforces THAT it happens with the save;
 * this class is the first layer allowed to know the table exists.
 *
 * actor is 'system' for aggregate-recorded facts: a human's involvement is
 * itself a payload fact (deactivate carries `by`), not a different writer —
 * the aggregate decided, the system recorded. Revisit only if the event
 * stream ever needs per-user attribution at the actor level.
 */
export abstract class PgAggregateRepository<A extends AggregateRoot<unknown>> extends AggregateRepository<A> {
  /** The stream name — matches the legacy emitters' vocabulary ('customer', 'invoice', …). */
  protected abstract readonly aggregateName: string

  protected async publishEvents(aggregate: A, events: DomainEvent[], tx: Tx): Promise<void> {
    if (events.length === 0) return
    await asDb(tx)
      .insertInto("billing.events")
      .values(
        events.map((e) => ({
          occurred_at: e.at,
          aggregate: this.aggregateName,
          aggregate_id: String(aggregate.id),
          type: e.type,
          actor: "system",
          participants: [...e.participants],
          payload: JSON.stringify(e.payload),
        })),
      )
      .execute()
  }
}
