/**
 * Task entity — the customer-level recurring service contract for a service
 * location. Holds whole-customer concerns: status, chem allowance, included
 * items, notes. Slot-level fields (tech, day, frequency, price) live on
 * `maintenance.task_schedules` so a customer can have N (tech, day) slots
 * for multi-day-per-week service.
 *
 * Lives in maintenance.tasks. Cross-module reads via this entity layer.
 */

export type TaskStatus = "active" | "paused" | "closed"

export interface Task {
  id: string
  service_location_id: number
  /** Customer-facing chem spend budget for notify/approve workflows. */
  chem_budget_cents: number | null
  included_items: unknown
  status: TaskStatus
  pause_reason: string | null
  starts_on: string
  ends_on: string | null
  notes: string | null
  external_source: string | null
  external_data: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/* Re-exports for module-private consumers; the canonical schedule shape
 * lives in app/(shell)/maintenance/_lib/views.ts since schedules are
 * read-only from cross-module callers (no entity-level mutations yet). */
