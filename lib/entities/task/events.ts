import type { Task } from "./types"

export type TaskEvent =
  | { type: "task.created"; id: string; task: Task }
  | { type: "task.updated"; id: string; before: Task; after: Task }
  | { type: "task.paused"; id: string; reason: string | null }
  | { type: "task.activated"; id: string }
  | { type: "task.closed"; id: string }

/**
 * Stub event emitter. The trigger-fed maintenance.tasks_audit table already
 * captures the durable change history; this is the in-process surface for
 * future bus wiring.
 */
export async function emit(event: TaskEvent): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.log("[task event]", event.type, event)
  }
}
