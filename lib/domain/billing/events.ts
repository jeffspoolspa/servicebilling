/**
 * Domain events — how aggregates testify to what happened.
 *
 * ADR 010 already fixed the architecture: `billing.events` is the append-only
 * history plane ("reads verify; diffs testify"), names are permanent and live
 * in docs/conventions/EVENT_VOCABULARY.md. This file gives AGGREGATES a way
 * to participate: an aggregate records events as it mutates; the application
 * service pulls them after a successful save and the repository appends them
 * to billing.events in the same transaction. State tables become rebuildable
 * projections — `Invoice.replay(events)` proves it.
 *
 * Rule: any `type` used here must be registered in EVENT_VOCABULARY.md
 * before the emit wiring goes live. The domain never invents names ad hoc.
 */

export interface DomainEvent {
  readonly aggregate: string
  readonly aggregateId: string
  readonly type: string
  readonly payload: Record<string, unknown>
  /** Domain time — when the fact happened, not when we stored it. */
  readonly occurredAt: string
}

/**
 * Base for aggregates that testify. `record()` inside mutators; the
 * application layer `pullEvents()` after save — pulling clears the buffer so
 * a retried save cannot double-append.
 */
export abstract class EventRecorder {
  private uncommitted: DomainEvent[] = []

  protected record(e: DomainEvent): void {
    this.uncommitted.push(e)
  }

  pullEvents(): DomainEvent[] {
    const out = this.uncommitted
    this.uncommitted = []
    return out
  }
}
