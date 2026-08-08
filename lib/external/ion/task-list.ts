/**
 * ION task list — TIER ½ of the intake funnel: the id-grade resolver
 * between the sweep (customer-grain detection) and the form (authority).
 *
 * Surface: f/ION/api/get_customer_tasks — one request per customer, fields
 * verified against a live payload 2026-08-08 (Deen, cust 2545480). This is
 * the surface that adjudicated the Deen flip-war in seconds while the form
 * was being difficult: it carries ids, days, parity and tech — everything
 * detection needs to say WHICH task moved, nothing convergence may trust
 * for money or terms (that stays the form's).
 *
 *   tier 0  Event Summary sweep         customer-grain "something moved"
 *   tier ½  THIS — customer's task list  which task · which fields class
 *   tier 1  task form (custId-primed!)   the authority → translate → converge
 */

/** One row as get_customer_tasks reports it — field names verbatim from the
 *  live payload; a stranger/missing field refuses (shape discipline). */
export interface IonTaskListRow {
  readonly ionTaskId: string
  readonly expired: boolean
  /** 0=Sun..6=Sat — the days ION says are serviced. */
  readonly activeDays: readonly number[]
  readonly assignedTo: string
  readonly recurrence: string // "Weekly" | "Bi-Weekly" | ... (ION's labels)
  /** ION's own week-index parity for interval cadences. */
  readonly weekParity: number
  readonly taskStarts: string // MM/DD/YYYY as ION renders it
  readonly taskExpires: string // "Perpetual" | a date
  readonly nextService: string
  readonly description: string
}

export type ListIntake =
  | { ok: true; rows: IonTaskListRow[] }
  | { ok: false; failed: string; raw: unknown }

const REQUIRED = ["ionTaskId", "expired", "activeDays", "assignedTo", "recurrence", "weekParity"] as const

/** FACTORY for the script's payload. Refusals keep the raw (replayable). */
export function ionTaskListFrom(payload: unknown): ListIntake {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { tasks?: unknown }).tasks)) {
    return { ok: false, failed: "payload has no tasks[]", raw: payload }
  }
  const rows: IonTaskListRow[] = []
  for (const t of (payload as { tasks: Record<string, unknown>[] }).tasks) {
    const missing = REQUIRED.filter((k) => !(k in t))
    if (missing.length) return { ok: false, failed: `task row missing [${missing.join(",")}] — shape changed?`, raw: payload }
    rows.push({
      ionTaskId: String(t.ionTaskId),
      expired: Boolean(t.expired),
      activeDays: (t.activeDays as number[]).map(Number),
      assignedTo: String(t.assignedTo ?? ""),
      recurrence: String(t.recurrence ?? ""),
      weekParity: Number(t.weekParity ?? 0),
      taskStarts: String(t.taskStarts ?? ""),
      taskExpires: String(t.taskExpires ?? ""),
      nextService: String(t.nextService ?? ""),
      description: String(t.description ?? ""),
    })
  }
  return { ok: true, rows }
}

/**
 * The Deen invariant, checkable at THIS tier: a task's day-count must agree
 * with its recurrence class. ION structurally can't disagree with itself
 * (one form), so any mismatch found here is OUR mirror lying — a repair
 * ticket against the cache, never against ION.
 */
export function mirrorDisagreements(
  row: IonTaskListRow,
  mirror: { activeDayCount: number; frequency: string },
): string[] {
  const out: string[] = []
  if (row.activeDays.length !== mirror.activeDayCount) {
    out.push(`day-count: ION says ${row.activeDays.length} [${row.activeDays.join(",")}], mirror has ${mirror.activeDayCount} active slots`)
  }
  return out
}
