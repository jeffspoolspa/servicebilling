/**
 * Visit entity — one service occurrence at a service location.
 *
 * Generated weekly from active tasks (via Windmill flow) or inserted manually
 * for QC / service-call / repair / makeup visits. Snapshots from task at
 * generation time so billing reads a stable per-visit price even when the
 * task changes mid-cycle.
 *
 * Manual reassignment is detectable by:
 *   visit_date <> scheduled_date  OR
 *   actual_tech_id <> scheduled_tech_id
 */

export type VisitStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "skipped"
  | "canceled"

export type VisitType =
  | "route"
  | "qc"
  | "makeup"
  | "service_call"
  | "repair"
  | "seasonal"

export type SnapshotFrequency = "weekly" | "biweekly_a" | "biweekly_b" | "monthly"

export interface Visit {
  id: string
  service_location_id: string
  task_id: string | null

  // Scheduled (locked at generation) vs Actual (mutable)
  scheduled_date: string
  visit_date: string
  scheduled_tech_id: string | null
  actual_tech_id: string | null

  scheduled_start: string | null
  started_at: string | null
  ended_at: string | null

  status: VisitStatus
  visit_type: VisitType

  // Snapshots locked at generation/creation
  price_cents: number | null
  snapshot_frequency: SnapshotFrequency | null

  // Linkage out
  work_order_id: string | null

  // External source-of-truth IDs
  ion_work_order_id: string | null
  skimmer_visit_id: string | null
  external_source: string | null

  notes: string | null
  created_at: string
  updated_at: string

  // Derived flags (computed by enrich)
  /** True if visit_date or actual_tech_id has been overridden away from the snapshot. */
  is_manually_reassigned: boolean
}
