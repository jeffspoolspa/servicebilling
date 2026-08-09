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
  dryRun: boolean
}

export interface ChangeReport {
  plan: IonWritePlan["kind"]
  newStartsOn: string | null
  /** The current period's still-scheduled old visits that SERVE OUT
   *  before EndsOn — the seam is anchored on them (period-clear, RULED). */
  clearedVisits: string[]
  /** Next-period old visits the EndsOn cuts — the change takes effect as
   *  a new period. SEEN, never silent. */
  cutVisits: string[]
  ops: WriteOp[]
  echoes: WriteEcho[]
  recorded: boolean
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
    // the period diff and answers supersede, exactly the ruled write shape
    period: input.targetAnchorDate
      ? { ...current.schedule.period, startsOn: input.targetAnchorDate }
      : current.schedule.period,
    stops: input.targetStops.map((s) => ({ weekday: s.weekday, techId: s.techId })),
    note: form.note,
  }
  const plan = planWrite(current, target, input.effectiveDate)
  const newStartsOn =
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
  const ops = renderWrites(form, plan, newStartsOn ?? undefined, oldEnds)

  const echoes: WriteEcho[] = []
  for (const op of ops) echoes.push(await deps.execute(op, input.dryRun))

  let recorded = false
  if (!input.dryRun && echoes.length && echoes.every((e) => e.committed)) {
    const agreement = await deps.repo.byIonTaskId(input.ionTaskId, input.effectiveDate)
    if (!agreement) throw new Error(`no agreement holds ${input.ionTaskId}`)
    const slice = agreement.openIncarnations().find((i) => i.ionTaskId === input.ionTaskId)
    if (!slice) throw new Error(`${input.ionTaskId} is not an open slice`)
    const at = new Date().toISOString()

    // incarnation from the ECHO: supersede should have echoed a new id;
    // a kept id fires ion_prediction_missed inside recordIncarnation
    const echoedNewId = echoes.find((e) => e.echoedTaskId)?.echoedTaskId ?? input.ionTaskId
    agreement.recordIncarnation(
      { ionTaskId: echoedNewId, cause: "placement_change", covers: slice.covers },
      at,
      { newIncarnation: plan.kind === "supersede" },
    )
    await deps.repo.save(agreement)

    // placement version: the slice's stops changed; compose the agreement's
    // full stop set = head minus THIS slice's old stops plus its new ones
    // (matching by value, not by type — a sibling slice of the SAME type,
    // like Winding River's second chem task, must survive untouched)
    const head = await headStops(deps, agreement.id, agreement.currentTerms().version)
    const oldOwn = new Set(current.schedule.stops.map((s) => `${current.stopType}|${s.weekday}|${s.techId}`))
    const others = (head ?? []).filter((s) => !oldOwn.has(`${s.type}|${s.weekday}|${s.techId}`))
    const stops = [...others, ...input.targetStops]
    await convergePlacement(deps.quotas, {
      agreementId: agreement.id, termsVersion: agreement.currentTerms().version,
      pattern: agreement.currentTerms().pattern as never, stops,
      fromDate: newStartsOn ?? input.effectiveDate, cause: "transition",
    })
    recorded = true
  }

  return { plan: plan.kind, newStartsOn, clearedVisits, cutVisits, ops, echoes, recorded }
}

async function headStops(deps: ChangeDeps, agreementId: string, termsVersion: number): Promise<PlacementStop[] | null> {
  const q = await deps.quotas.quotaFor(agreementId, termsVersion)
  if (!q) return null
  const head = await deps.quotas.headPlacement(q.id)
  return head?.stops ?? null
}
