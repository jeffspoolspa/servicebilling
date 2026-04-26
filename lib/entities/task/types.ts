/**
 * Task entity — the live assignment per service location: tech + day +
 * frequency + per-visit labor price + sequence + commercial extras.
 *
 * Mutated in place as things change (tech swap, day change, seasonal
 * frequency change). Visits snapshot from Task at generation time, so
 * mid-cycle Task changes don't retroactively re-price already-generated
 * visits — billing reads visit.price_cents.
 *
 * Lives in maintenance.tasks. Cross-module reads via this entity layer.
 */

export type TaskStatus = "active" | "paused" | "closed"
export type TaskFrequency = "weekly" | "biweekly_a" | "biweekly_b" | "monthly"

/** 0 = Sunday, 6 = Saturday. Matches Postgres EXTRACT(dow FROM ...). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface Task {
  id: string
  service_location_id: string
  tech_employee_id: string | null
  day_of_week: DayOfWeek | null
  frequency: TaskFrequency | null
  /** LABOR per visit (Jeff's bills chems on top — this is not flat-rate). */
  price_per_visit_cents: number | null
  /** Customer-facing chem spend budget for notify/approve workflows. NOT a price cap. */
  chem_budget_cents: number | null
  included_items: unknown
  /** Order within (tech, day_of_week). */
  sequence: number | null
  status: TaskStatus
  pause_reason: string | null
  starts_on: string
  ends_on: string | null
  notes: string | null
  // External source-of-truth (Skimmer is initial source for tasks)
  skimmer_id: string | null
  external_source: string | null
  created_at: string
  updated_at: string
}
