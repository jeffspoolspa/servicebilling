/**
 * ChangeArrangement — THE outbound sentence: realize a planned placement
 * change for ONE slice. Fetch the slice's live form, let the ACL decide the
 * write kind from the diff (I-T8: amend | supersede | none — never chosen
 * by a caller), render the exact form operations, execute them, and record
 * only what ION ECHOED — placement version and incarnation from the echo,
 * never from the prediction.
 *
 *   fresh form ─► translate ─► planWrite(current, target) ─► renderWrites
 *   ─► execute (DRY-RUN unless explicitly armed) ─► echo ─► record:
 *        placement version (cause "transition") + incarnation
 *        (placement_change; a kept id with predicted supersede fires
 *        ion_prediction_missed — the loud fact, RULED)
 *
 * Dry-run is the default the whole way down: the Windmill write surface,
 * this sentence, and the harness all require an explicit live=true.
 */

import type { PlacementStop, QuotaStore } from "../domain/ports/quota-store"
import type { TaskFormSource } from "../../agreements/domain/ports/task-form-source"
import type { AgreementRepository } from "../../agreements/domain/ports/agreement-repository"
import { convergePlacement } from "./converge-placement"
import { ionTaskFormFrom, translateTask, type IonTaskForm } from "../../external/ion/task-translation"
import { planWrite, type IonWritePlan } from "../../external/ion/ion-write-plan"
import { renderWrites, type WriteOp } from "../../external/ion/render-write"
import { projectFirings } from "../domain/transition/project-firings"

/** One crossed-off step of THE DECLARED PROCESS (RULED 2026-08-09). */
export interface StepRecord {
  step: string
  status: "passed" | "failed"
  at: string
  /** layer · class/module · method doing this step (the declared table). */
  by: string
  evidence?: unknown
}

/**
 * THE DECLARED PROCESS (RULED 2026-08-09): a publish move is a series of
 * named steps; each names the layer, class and method doing it, and each
 * completes only on a VERIFYING READ of ION's state — never its response.
 * The move is done only when verify_floor passes: the converged placements
 * row matches the target, written exclusively from confirmed writes/reads.
 */
export const WRITE_PROCESS: Record<string, string> = {
  read_current: "acl · lib/external/ion/task-translation · ionTaskFormFrom + translateTask",
  plan: "acl · lib/external/ion/ion-write-plan · planWrite",
  end_old: "external · f/ION/_lib/task_detail · updateTask — verified by task-list Expires read-back",
  amend_form: "external · f/ION/_lib/task_detail · updateTask — verified by form re-read field compare",
  create_successor: "external · f/ION/_lib/task_detail · createTask — verified by list sandwich (born id exact)",
  verify_target: "application · change-arrangement · verifyBorn — born row vs target stops",
  record_book: "domain · ServiceAgreement · recordIncarnation — successor = the CONFIRMED id",
  converge_placement: "application · converge-placement · convergePlacement",
  verify_floor: "application · change-arrangement · head placement read-back vs target — THE DONE GATE",
}

/** Pure: does the born task's list row match the target arrangement? */
export function verifyBorn(
  born: { taskStarts?: string; activeDays?: number[]; assignedTo?: string } | null,
  target: readonly { weekday: number }[],
  newStartsOn: string | null,
  wantTechName: string | null,
): { ok: boolean; why?: string } {
  if (!born) return { ok: false, why: "no born row (create unverified)" }
  const wantDays = [...new Set(target.map((s) => s.weekday))].sort().join(",")
  const gotDays = [...(born.activeDays ?? [])].sort().join(",")
  if (wantDays !== gotDays) return { ok: false, why: `days: want [${wantDays}] got [${gotDays}]` }
  if (newStartsOn) {
    const mdy = `${Number(newStartsOn.slice(5, 7))}/${Number(newStartsOn.slice(8, 10))}/${newStartsOn.slice(0, 4)}`
    const gs = (born.taskStarts ?? "").replace(/\b0/g, "")
    if (gs !== mdy.replace(/\b0/g, "")) return { ok: false, why: `starts: want ${mdy} got ${born.taskStarts}` }
  }
  if (wantTechName && born.assignedTo && born.assignedTo.trim() !== wantTechName.trim())
    return { ok: false, why: `tech: want "${wantTechName}" got "${born.assignedTo}"` }
  return { ok: true }
}

export interface WriteEcho {
  op: WriteOp
  dryRun: boolean
  committed: boolean
  /** For creates ION's response names the new task id (parsed by the
   *  adapter when live); null on dry runs and amends. */
  echoedTaskId: string | null
  preview: unknown
}

export interface ChangeDeps {
  forms: TaskFormSource
  repo: AgreementRepository
  quotas: QuotaStore
  /** The Windmill write surface (f/ION/api/write_task). */
  execute: (op: WriteOp, dryRun: boolean) => Promise<WriteEcho>
  catalogPriceCents: (serviceTypeId: string) => number | null
  /** ION display name for a numeric tech id (employees.ion_username) —
   *  lets verify_target check the born row's AssignedTo without another
   *  ION read. Optional: absent skips the name comparison. */
  techNameOf?: (ionTechId: string) => string | null
}

export interface ChangeInput {
  ionTaskId: string
  ionCustId: string
  /** Target stops for THIS slice (typed stops of one covers-slice). */
  targetStops: readonly PlacementStop[]
  /** Planner-computed: the change may not serve before this date. */
  effectiveDate: string
  /** AnchorShifted only: the planner's window-checked anchor date. The new
   *  task's StartsOn IS this date (StartsOn is the parity anchor for
   *  interval cadences — ION's triple-duty field). */
  targetAnchorDate?: string
  /** The successor's period end — the AGREEMENT's truth (stored pre-cut
   *  translation), never the freshly cut form's EndsOn: a resumed
   *  supersede must not propagate its own cut onto the successor, and an
   *  annual commercial must keep its real contract end. undefined =
   *  trust the live form (standalone harness use). */
  targetEndsOn?: string | null
  dryRun: boolean
  /** live progress: called after every step crossing (fire-and-forget). */
  onStep?: (steps: StepRecord[]) => void | Promise<void>
}

export interface ChangeReport {
  plan: IonWritePlan["kind"]
  newStartsOn: string | null
  /** live only: why recording was skipped (task outside the book — e.g.
   *  a throwaway test task). LOUD in the report, never an exception after
   *  writes already committed. */
  recordSkipped?: string
  /** live only: the placement could not be recorded because the stored
   *  terms disagree with the agreement's CURRENT slices (multi-slice
   *  agreements whose terms predate a slice). ION is written; the book
   *  reconciles on the next refresh. Reported, never thrown — a publish
   *  must not fail on our own stale bookkeeping (2026-08-09). */
  placementDeferred?: string
  /** The current period's still-scheduled old visits that SERVE OUT
   *  before EndsOn — the seam is anchored on them (period-clear, RULED). */
  clearedVisits: string[]
  /** Next-period old visits the EndsOn cuts — the change takes effect as
   *  a new period. SEEN, never silent. */
  cutVisits: string[]
  ops: WriteOp[]
  echoes: WriteEcho[]
  recorded: boolean
  /** the crossed-off process — one record per step, with evidence. */
  steps: StepRecord[]
  /** true ONLY when verify_floor passed: the placements row matches the
   *  target. Anything less is not done (RULED 2026-08-09). */
  verified: boolean
}

/**
 * PERIOD-CLEAR EndsOn (RULED 2026-08-08): a change is thought of as a NEW
 * PERIOD. The old task's current period serves out — its still-scheduled
 * visit clears (it would have been done anyway; cutting it just buys a
 * free bridge for nothing) — and EndsOn lands on that period's Sunday.
 * Only NEXT-period old firings are cut. No pending visit at all -> the
 * ceiling (newStartsOn - 1) stands. The write can happen any day; nobody
 * waits for Sunday — EndsOn does the waiting.
 */
export function periodClearEndsOn(
  oldConfig: { cadence: import("../domain/transition/cadence-law").CadenceKind; weekdays: number[]; anchorDate: string | null },
  newStartsOn: string,
  today: string,
): { endsOn: string; clearedVisits: string[]; cutVisits: string[] } {
  const ceiling = addDaysIso(newStartsOn, -1)
  const from = addDaysIso(today, 1)
  const pending = from <= ceiling ? projectFirings(oldConfig, from, ceiling) : []
  // the current period = the anchor-aligned cycle containing TODAY
  const interval = oldConfig.cadence.kind === "biweekly" ? 2 : oldConfig.cadence.kind === "monthly" ? 4 : 1
  let periodEnd = sundayOfWeekIso(today)
  if (interval > 1 && oldConfig.anchorDate) {
    const wk = (a: string, b: string) =>
      Math.round((Date.parse(`${mondayIso(b)}T00:00:00Z`) - Date.parse(`${mondayIso(a)}T00:00:00Z`)) / (7 * 86_400_000))
    const off = ((wk(oldConfig.anchorDate, today) % interval) + interval) % interval
    periodEnd = addDaysIso(sundayOfWeekIso(today), (interval - 1 - off) * 7)
  }
  const endsOn = periodEnd < ceiling ? periodEnd : ceiling
  return {
    endsOn,
    clearedVisits: pending.filter((d) => d <= endsOn),
    cutVisits: pending.filter((d) => d > endsOn),
  }
}

const mondayIso = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  const shift = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - shift)
  return d.toISOString().slice(0, 10)
}

const sundayOfWeekIso = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  const shift = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - shift + 6)
  return d.toISOString().slice(0, 10)
}

const addDaysIso = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** First date on/after `fromDate` whose weekday is in the target day set. */
export function firstServiceDate(fromDate: string, weekdays: readonly number[]): string {
  const d = new Date(`${fromDate}T00:00:00Z`)
  for (let i = 0; i < 7; i++) {
    if (weekdays.includes(d.getUTCDay())) return d.toISOString().slice(0, 10)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  throw new Error("no target weekday within a week — empty day set?")
}

export async function changeArrangement(deps: ChangeDeps, input: ChangeInput): Promise<ChangeReport> {
  const [res] = await deps.forms.fetchForms([{ ionTaskId: input.ionTaskId, ionCustId: input.ionCustId }])
  if (!res.ok) throw new Error(`cannot fetch live form for ${input.ionTaskId}: ${res.error}`)
  const intake = ionTaskFormFrom({ fields: res.fields, detail: res.detail as never })
  if (!intake.ok) throw new Error(`live form refused translation: ${intake.failed}`)
  const form: IonTaskForm = intake.value
  const tr = translateTask(form, deps.catalogPriceCents)
  if (!tr.ok) throw new Error(`live form refused translation: ${tr.failed}`)
  const current = tr.value

  const target = {
    pattern: current.schedule.frequency, // placement change: terms untouched
    billing: current.billing,
    // an anchor flip moves StartsOn (the parity anchor) — planWrite reads
    // the period diff and answers supersede, exactly the ruled write shape.
    // endsOn: the agreement's truth when given (see targetEndsOn).
    period: {
      startsOn: input.targetAnchorDate ?? current.schedule.period.startsOn,
      endsOn: input.targetEndsOn !== undefined ? input.targetEndsOn : current.schedule.period.endsOn,
    },
    stops: input.targetStops.map((s) => ({ weekday: s.weekday, techId: s.techId })),
    note: form.note,
  }
  const plan = planWrite(current, target, input.effectiveDate)
  let newStartsOn =
    plan.kind !== "supersede" ? null
      : input.targetAnchorDate ?? firstServiceDate(input.effectiveDate, target.stops.map((s) => s.weekday))
  let cutVisits: string[] = []
  let clearedVisits: string[] = []
  let oldEnds: string | undefined
  if (plan.kind === "supersede" && newStartsOn) {
    const pc = periodClearEndsOn(
      {
        cadence: current.schedule.frequency,
        weekdays: current.schedule.stops.map((s) => s.weekday),
        anchorDate: current.schedule.period.startsOn,
      },
      newStartsOn,
      new Date().toISOString().slice(0, 10),
    )
    cutVisits = pc.cutVisits
    clearedVisits = pc.clearedVisits
    if (pc.endsOn !== addDaysIso(newStartsOn, -1)) oldEnds = pc.endsOn
  }
  // THE TIMING LAW (RULED 2026-08-08): a tech swap whose current-period
  // visit is ALREADY SERVED is an immediate change -> amend in place. One
  // still PENDING makes it a next-period change -> supersede with dates
  // (EndsOn = the period's Sunday, the old tech finishes the week they
  // own; StartsOn = the first firing after). Everything posts NOW — the
  // dates do the waiting, no write scheduling exists.
  let effectivePlan = plan
  if (plan.kind === "amend") {
    const today = new Date().toISOString().slice(0, 10)
    const pc = periodClearEndsOn(
      {
        cadence: current.schedule.frequency,
        weekdays: current.schedule.stops.map((s) => s.weekday),
        anchorDate: current.schedule.period.startsOn,
      },
      addDaysIso(today, 28),
      today,
    )
    if (pc.clearedVisits.length) {
      effectivePlan = { kind: "supersede", target: plan.target, effectiveWeekOf: input.effectiveDate }
      newStartsOn = firstServiceDate(addDaysIso(pc.endsOn, 1), input.targetStops.map((s) => s.weekday))
      oldEnds = pc.endsOn
      clearedVisits = pc.clearedVisits
      // same day-set: the new task re-covers any later dates itself — no cuts
    }
  }
  const ops = renderWrites(form, effectivePlan, newStartsOn ?? undefined, oldEnds)

  const steps: StepRecord[] = []
  const cross = (step: string, status: "passed" | "failed", evidence?: unknown) => {
    steps.push({ step, status, at: new Date().toISOString(), by: WRITE_PROCESS[step] ?? step, evidence })
    if (input.onStep) void Promise.resolve(input.onStep(steps)).catch(() => {})
  }
  cross("read_current", "passed", {
    stops: current.schedule.stops, period: current.schedule.period, cadence: current.schedule.frequency.kind,
  })
  cross("plan", "passed", {
    kind: effectivePlan.kind, newStartsOn, oldEnds: oldEnds ?? null,
    ops: ops.map((o) => ({ op: o.op, changes: o.changes })),
  })

  const echoes: WriteEcho[] = []
  for (const op of ops) {
    const stepName = op.op === "create" ? "create_successor"
      : op.changes && "EndsOn" in op.changes && effectivePlan.kind === "supersede" ? "end_old" : "amend_form"
    const echo = await deps.execute(op, input.dryRun)
    echoes.push(echo)
    if (input.dryRun) { cross(stepName, "passed", { dry_run: true }); continue }
    const ev = (echo.preview ?? {}) as Record<string, unknown>
    if (echo.committed) {
      cross(stepName, "passed", {
        verified: ev.verified, new_task_id: ev.new_task_id, born_row: ev.born_row, status: ev.status,
      })
    } else {
      // HALT ON FAILURE (RULED 2026-08-09): a failed verb stops the move —
      // never end an old task and skip its successor silently, and never
      // create on top of an unconfirmed end.
      cross(stepName, "failed", {
        status: ev.status, verified: ev.verified, ambiguous_births: ev.ambiguous_births,
        still: "remaining verbs NOT executed",
      })
      break
    }
  }

  // verify_target: the born task's own list row must match the arrangement
  const createEcho = echoes.find((e) => e.op.op === "create")
  if (!input.dryRun && createEcho?.committed) {
    const bornRow = ((createEcho.preview ?? {}) as { born_row?: { taskStarts?: string; activeDays?: number[]; assignedTo?: string } }).born_row ?? null
    const primaryTech = input.targetStops[0]?.techId ?? null
    const v = verifyBorn(bornRow, input.targetStops, newStartsOn,
      primaryTech && deps.techNameOf ? deps.techNameOf(primaryTech) : null)
    cross("verify_target", v.ok ? "passed" : "failed", v.ok ? { born: bornRow } : { why: v.why, born: bornRow })
    if (!v.ok) {
      return { plan: effectivePlan.kind, newStartsOn, clearedVisits, cutVisits, ops, echoes,
        recorded: false, steps, verified: false,
        recordSkipped: `verify_target failed: ${v.why} — book NOT updated, reconcile required` }
    }
  }

  let recorded = false
  let recordSkipped: string | undefined
  let placementDeferred: string | undefined
  let verified = false
  if (!input.dryRun && echoes.length && echoes.every((e) => e.committed)) {
    const agreement = await deps.repo.byIonTaskId(input.ionTaskId, input.effectiveDate)
    const slice = agreement?.openIncarnations().find((i) => i.ionTaskId === input.ionTaskId)
    if (!agreement || !slice) {
      recordSkipped = `no open agreement slice for ${input.ionTaskId} — writes committed, book NOT updated (throwaway task?)`
      cross("record_book", "failed", { why: recordSkipped })
      return { plan: effectivePlan.kind, newStartsOn, clearedVisits, cutVisits, ops, echoes, recorded, recordSkipped, steps, verified }
    }
    const at = new Date().toISOString()

    // incarnation from the ECHO: supersede should have echoed a new id;
    // a kept id fires ion_prediction_missed inside recordIncarnation
    const echoedNewId = echoes.find((e) => e.echoedTaskId)?.echoedTaskId ?? input.ionTaskId
    agreement.recordIncarnation(
      { ionTaskId: echoedNewId, cause: "placement_change", covers: slice.covers },
      at,
      { newIncarnation: effectivePlan.kind === "supersede" },
    )
    await deps.repo.save(agreement)
    cross("record_book", "passed", {
      successor: echoedNewId,
      confirmed: echoedNewId !== input.ionTaskId,
    })

    // placement version: the slice's stops changed; compose the agreement's
    // full stop set = head minus THIS slice's old stops plus its new ones
    // (matching by value, not by type — a sibling slice of the SAME type,
    // like Winding River's second chem task, must survive untouched)
    // COMPOSE BY SLICE, NOT BY VALUE (2026-08-09): matching the head's
    // stops against the current form's values left a phantom whenever the
    // head was stale (a wrong-tech publish put Wesley in the head while
    // the form read Carlos — the "requires 1 stop but carries 2" refusal).
    // A slice OWNS its stop type when it is the agreement's only open
    // slice of that type: replace them wholesale. With sibling slices of
    // the same type present, fall back to value matching until stops
    // carry their slice id.
    const head = await headStops(deps, agreement.id, agreement.currentTerms().version)
    const siblingsSameType = agreement.openIncarnations()
      .filter((i) => i.covers.stopType === slice.covers.stopType).length
    const others = siblingsSameType <= 1
      ? (head ?? []).filter((s) => s.type !== slice.covers.stopType)
      : (head ?? []).filter((s) => {
          const oldOwn = new Set(current.schedule.stops.map((x) => `${current.stopType}|${x.weekday}|${x.techId}`))
          return !oldOwn.has(`${s.type}|${s.weekday}|${s.techId}`)
        })
    const stops = [...others, ...input.targetStops]
    try {
      await convergePlacement(deps.quotas, {
        agreementId: agreement.id, termsVersion: agreement.currentTerms().version,
        pattern: agreement.currentTerms().pattern as never, stops,
        fromDate: newStartsOn ?? input.effectiveDate, cause: "transition",
      })
      recorded = true
      cross("converge_placement", "passed", { stops })
    } catch (e) {
      // The ION write is DONE. Refusing here would leave the operator with
      // a red toast for a change that landed — and no record of it. The
      // agreement's terms are stale against its own slices; the refresh
      // sentence recomposes them. Report and move on.
      placementDeferred = `${String(e).replace(/^Error: /, "")} — ION is written; the book reconciles on refresh`
      cross("converge_placement", "failed", { why: placementDeferred })
    }

    // THE DONE GATE (RULED 2026-08-09): re-read the head placement and
    // compare to the composed target. done means the placements row
    // matches — nothing less.
    if (recorded) {
      const back = await headStops(deps, agreement.id, agreement.currentTerms().version)
      const want = new Set(stops.map((x) => `${x.type}|${x.weekday}|${x.techId}`))
      const got = new Set((back ?? []).map((x) => `${x.type}|${x.weekday}|${x.techId}`))
      const match = want.size === got.size && [...want].every((k) => got.has(k))
      cross("verify_floor", match ? "passed" : "failed",
        match ? { placements: [...got] } : { want: [...want], got: [...got] })
      verified = match
    }
  }

  return { plan: effectivePlan.kind, newStartsOn, clearedVisits, cutVisits, ops, echoes, recorded, recordSkipped, placementDeferred, steps, verified }
}

async function headStops(deps: ChangeDeps, agreementId: string, termsVersion: number): Promise<PlacementStop[] | null> {
  const q = await deps.quotas.quotaFor(agreementId, termsVersion)
  if (!q) return null
  const head = await deps.quotas.headPlacement(q.id)
  return head?.stops ?? null
}
