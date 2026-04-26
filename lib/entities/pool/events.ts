import type { Pool } from "./types"

export type PoolEvent =
  | { type: "pool.created"; id: string; pool: Pool }
  | { type: "pool.updated"; id: string; before: Pool; after: Pool }
  | { type: "pool.deactivated"; id: string; reason: string | null }

/**
 * Stub event emitter. Real bus wiring (realtime, queue, webhook fanout) lands
 * in a separate plan; this is the surface mutations will call once it's wired.
 */
export async function emit(event: PoolEvent): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.log("[pool event]", event.type, event)
  }
}
