/**
 * renderWrites — IonWritePlan → the exact form operations ION receives.
 * The last translation step outbound: semantic plan in, field names and
 * MM/DD/YYYY strings out. Pure; the executor (Windmill write_task) POSTs.
 *
 * The timing law (RULED 2026-08-08) rendered concrete:
 *   supersede = EndsOn the old task, create the new task with StartsOn =
 *   the first service date. ION deletes scheduled visits after EndsOn and
 *   generates from StartsOn.
 *
 *   EndsOn is NOT blindly newStartsOn-1 (CORRECTED 2026-08-08): the old
 *   task may still have SCHEDULED visits between the cursor and that date
 *   — visits the verified plan never counted (the planner reads completed
 *   visits). The caller computes oldEndsOn to cut every pending old firing
 *   the plan excluded; newStartsOn-1 is only the ceiling.
 *   amend = tech VALUES only, POSTed onto the existing form (same id
 *   predicted; the echo verifies).
 *
 * The create op clones the CURRENT form's rawFields — every hidden input
 * ION expects rides along verbatim (the reason rawFields exist) — then
 * overwrites identity (EventID out), schedule, and period.
 */

import type { IonTaskForm } from "./task-translation"
import type { IonWritePlan } from "./ion-write-plan"

export interface WriteOp {
  readonly op: "update" | "create"
  readonly ionTaskId: string | null // null = create
  readonly ionCustId: string
  readonly changes: Record<string, string>
  /** create only: the full field set to POST (rawFields clone + changes). */
  readonly fields?: Record<string, string>
  readonly why: string
}

/** ION renders dates MM/DD/YYYY. */
export function ionDate(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${m}/${d}/${y}`
}

const isoMinusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** day1=Sunday .. day7=Saturday (ION's form fields). */
const dayField = (weekday: number) => `day${weekday + 1}`

export function renderWrites(
  form: IonTaskForm,
  plan: IonWritePlan,
  /** The first date the NEW arrangement serves (planner-computed: first
   *  target weekday on/after the effective date — semantic time resolved
   *  by the caller, never invented here). Supersede only. */
  newStartsOn?: string,
  /** The old task's last legal service day — computed by the caller to cut
   *  pending old firings the plan excluded. Defaults to newStartsOn-1. */
  oldEndsOn?: string,
): WriteOp[] {
  if (plan.kind === "none") return []

  if (plan.kind === "amend") {
    const changes: Record<string, string> = {}
    const currentByDay = new Map<number, string>()
    for (const [d, t] of Object.entries(form.dayTechs)) currentByDay.set(Number(d), (t as { techId: string }).techId)
    for (const s of plan.target.stops) {
      if (currentByDay.get(s.weekday) !== s.techId) changes[dayField(s.weekday)] = s.techId
    }
    // interval cadences carry one AssignedTo instead of day fields
    if (form.assignedTechId && plan.target.stops.length === 1 && plan.target.stops[0].techId !== form.assignedTechId) {
      changes["AssignedTo"] = plan.target.stops[0].techId
    }
    return Object.keys(changes).length
      ? [{ op: "update", ionTaskId: form.eventId, ionCustId: form.customerId, changes, why: "amend: tech values only" }]
      : []
  }

  // supersede: two adjacent ops, never overlapping
  if (!newStartsOn) throw new Error("supersede requires newStartsOn (the planner's first service date)")
  const ends = oldEndsOn ?? isoMinusDays(newStartsOn, 1)
  const endOld: WriteOp = {
    op: "update", ionTaskId: form.eventId, ionCustId: form.customerId,
    changes: { EndsOn: ionDate(ends) },
    why: `supersede: old incarnation serves through ${ends}${oldEndsOn ? " (pending old firings cut)" : ""}`,
  }

  const fields: Record<string, string> = { ...form.rawFields }
  delete fields["EventID"] // a create has no identity yet
  for (let d = 1; d <= 7; d++) delete fields[`day${d}`]
  for (const s of plan.target.stops) fields[dayField(s.weekday)] = s.techId
  fields["StartsOn"] = ionDate(newStartsOn)
  fields["EndsOn"] = plan.target.period.endsOn ? ionDate(plan.target.period.endsOn) : ""
  const createNew: WriteOp = {
    op: "create", ionTaskId: null, ionCustId: form.customerId,
    changes: { StartsOn: fields["StartsOn"], EndsOn: fields["EndsOn"] },
    fields,
    why: `supersede: new incarnation serving from ${newStartsOn}`,
  }
  return [endOld, createNew]
}
