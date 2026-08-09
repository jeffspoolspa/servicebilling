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

/** Date wire format: MM/DD/YYYY — the PROVEN format on BOTH paths (the
 *  boundary test's create and its first EndsOn save). The 2026-08-09
 *  live run proved ISO 500s on the create path; the browser's ISO was
 *  the edit page's date-input serialization only. EndsOn remains
 *  write-only: verification reads the TASK LIST, never the form field. */
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

/** ION employee ids are numeric. A mirror UUID reaching a day select is
 *  the 2026-08-09 live-run bug (ION 500s on every op) — REFUSE at render
 *  so the class dies in dry runs, never live. */
const assertIonTechId = (techId: string): void => {
  if (!/^\d+$/.test(techId)) {
    throw new Error(`techId "${techId}" is not an ION employee id — map mirror uuids via employees.ion_employee_id before rendering`)
  }
}

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
      assertIonTechId(s.techId)
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
  for (const s of plan.target.stops) {
    assertIonTechId(s.techId)
    fields[dayField(s.weekday)] = s.techId
  }
  // AssignedTo: interval cadences READ THIS FIELD, not the day selects —
  // the 2026-08-09 incident cloned the OLD tech onto every biweekly
  // successor (Emily kept her superseded pools). Single-stop targets set
  // it; multi-day weekly clears it (the day selects rule there).
  fields["AssignedTo"] = plan.target.stops.length === 1 ? plan.target.stops[0].techId : ""
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

/** ION's ServiceRepeat option ids — captured live 2026-08-08 (closed;
 *  probe_repeat_options re-reads them if ION ever changes the list). */
export const SERVICE_REPEAT = {
  daily: "1", weekly: "2", biweekly: "3", monthly: "4",
} as const

/** QUALITY CONTROL @ $0.00 — the no-charge service type (data-grounded). */
export const QC_SERVICE_TYPE_ID = "1271674"

/**
 * renderBridgeOp — a BRIDGE VISIT as ION spells it (RULED 2026-08-08):
 * a DAILY task whose StartsOn = EndsOn = the bridge date — exactly one
 * generated visit, then it ends itself. Service type QUALITY CONTROL
 * (no charge); the incoming tech serves it. Fields clone the main
 * task's rawFields so every hidden input rides along.
 */
export function renderBridgeOp(
  form: IonTaskForm,
  bridge: { date: string; techId: string },
): WriteOp {
  const fields: Record<string, string> = { ...form.rawFields }
  delete fields["EventID"]
  for (let d = 1; d <= 7; d++) delete fields[`day${d}`]
  assertIonTechId(bridge.techId)
  const weekday = new Date(`${bridge.date}T00:00:00Z`).getUTCDay()
  fields[dayField(weekday)] = bridge.techId
  fields["AssignedTo"] = bridge.techId
  fields["ServiceRepeat"] = SERVICE_REPEAT.daily
  fields["ServiceType"] = QC_SERVICE_TYPE_ID
  fields["StartsOn"] = ionDate(bridge.date)
  fields["EndsOn"] = ionDate(bridge.date)
  fields["itemcost"] = ""
  fields["tasknote"] = "Transition bridge visit — no charge (auto)"
  return {
    op: "create", ionTaskId: null, ionCustId: form.customerId,
    changes: { StartsOn: bridge.date, EndsOn: bridge.date }, fields,
    why: `bridge rider: free QC visit ${bridge.date} (daily, one-day period)`,
  }
}
