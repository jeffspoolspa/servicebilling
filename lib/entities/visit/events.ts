import type { Visit } from "./types"

export type VisitEvent =
  | { type: "visit.generated"; id: string; visit: Visit }
  | { type: "visit.reassigned"; id: string; before: Visit; after: Visit }
  | { type: "visit.rescheduled"; id: string; before: Visit; after: Visit }
  | { type: "visit.started"; id: string }
  | { type: "visit.completed"; id: string }
  | { type: "visit.skipped"; id: string }
  | { type: "visit.canceled"; id: string }
  | { type: "visit.work_order_attached"; id: string; work_order_id: string }

/**
 * Stub event emitter. Visits don't have a separate audit table by design —
 * the row's scheduled-vs-actual fields plus updated_at are the audit trail.
 * This event surface is for downstream consumers (chem-budget watcher,
 * payroll feed, etc.) once the bus is wired.
 */
export async function emit(event: VisitEvent): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.log("[visit event]", event.type, event)
  }
}
