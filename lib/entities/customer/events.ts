import type { Customer } from "./types"

export type CustomerEvent =
  | { type: "customer.created"; id: string; customer: Customer }
  | { type: "customer.updated"; id: string; before: Customer; after: Customer }
  | { type: "customer.deactivated"; id: string; reason: string }

/**
 * Stub event emitter. When we add a real bus (Supabase realtime, queue, webhook
 * fanout, etc.) this is the one place that needs to change.
 */
export async function emit(event: CustomerEvent): Promise<void> {
  // TODO: write to billing.entity_events or fire to a webhook
  if (process.env.NODE_ENV !== "production") {
    console.log("[customer event]", event.type, event)
  }
}
