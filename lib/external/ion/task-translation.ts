/**
 * ION task translation — the ACL contract (RULED 2026-08-07).
 *
 * TRANSLATE-THEN-DIFF: the form becomes a versioned TaskTranslation keyed
 * (ionTaskId, observedAt); a "change" is two consecutive versions
 * disagreeing, per section. Nothing classifies raw field deltas directly —
 * the tier-1 raw ledger records every delta verbatim; this file computes
 * the tier-2 meaning. Representation churn without meaning change (daily ↔
 * weekly-7-filled) therefore produces NO section diff, by construction.
 *
 * FAILURE IS A STORED STATE: every refusal here returns {failed} with the
 * rawest surviving artifact attached — never a throw that discards input.
 * A window of ION UI change costs latency, never history.
 *
 * ION's awkwardness ledger, absorbed here so nothing above carries it:
 *   - task conflates contract + placements → schedule/billing sections split
 *   - StartsOn is triple-duty (period start · parity anchor · weekday for
 *     single-day cadences) → we RECORD the date; routing INTERPRETS parity
 *     (D6: the anchor is a quota decision, evidence ≠ decision)
 *   - daily is weekly×7 in two spellings → one canonical 7x translation
 *   - biweekly/monthly carry no per-day selects → stops constructed from
 *     the assigned tech + StartsOn's weekday
 *   - InvoiceType encodes three axes in one label → decode table (data-
 *     grounded 2026-08-07; flat rate collapses to summary, RULED)
 *   - stopPayFixed, invoiceDate: irrelevant to us — tier-1 only
 */

/* ------------------------------- intake ---------------------------------- */

/** 0=Sun .. 6=Sat — ION's convention, normalized at this boundary. */
export type IonWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Everything the addTask.cfm form says, typed. rawFields keeps the rest. */
export interface IonTaskForm {
  eventId: string
  customerId: string
  serviceType: { id: string; label: string }
  profile: { id: string; label: string }
  serviceRepeat: { id: string; label: string }
  invoiceType: { id: string; label: string }
  startsOn: string | null // ISO after factory normalization
  endsOn: string | null
  itemCostCents: number | null // null = catalog price governs (meaningful)
  note: string
  dayTechs: Partial<Record<IonWeekday, { techId: string; techName: string }>>
  /** The single-tech field biweekly/monthly forms use instead of dayTechs. */
  assignedTechId: string | null
  flags: { sendLog: boolean; sendConsumables: boolean; sendTechNote: boolean; sendFiles: boolean; imgRequired: boolean }
  /** The serialized form verbatim — hidden inputs included. Nothing dropped. */
  rawFields: Record<string, string>
}

export type Intake<T> =
  | { ok: true; value: T }
  | { ok: false; failed: string; raw: Record<string, string> }

/** Field names the factory expects. A stranger or an absentee is a
 *  FormShapeChanged — ION moved the furniture; park it, don't guess. */
const EXPECTED = new Set([
  "EventID", "CustomerID", "ServiceType", "profileid", "ServiceRepeat",
  "InvoiceType", "InvoiceDate", "StartsOn", "EndsOn", "StopPayFixed",
  "itemcost", "tasknote", "AssignedTo",
  "day1", "day2", "day3", "day4", "day5", "day6", "day7",
  "sendlog", "SendConsumables", "sendtechnote", "SendFiles", "imgRequired",
])
/** Present in every form but carrying no meaning for anyone — never flagged. */
const IGNORED_PREFIXES = ["__", "btn", "submit", "isIFrame"]

const DOW_FIELDS = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const

/** ION dates arrive as MM/DD/YY(YY) or already ISO. Anything else refuses. */
export function normalizeIonDate(raw: string): string | null | "invalid" {
  const s = raw.trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (!m) return "invalid"
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3]
  return `${yyyy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
}

export function centsFrom(raw: string): number | null | "invalid" {
  const s = raw.replace(/[$,\s]/g, "")
  if (!s) return null
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "invalid"
  return Math.round(parseFloat(s) * 100)
}

/**
 * FACTORY: parseTaskForm output → typed intake. The one place ION's raw
 * vocabulary (field names, date formats, dollar strings, day1=Sunday)
 * becomes ours. Refusals carry the raw fields — replayable after a fix.
 */
export function ionTaskFormFrom(parsed: {
  fields: Record<string, string>
  detail: {
    ionTaskId: string
    customerId: string
    serviceType: { value: string; text: string }
    profile: { value: string; text: string }
    serviceRepeat: { value: string; text: string }
    invoiceType: { value: string; text: string }
    startsOn: string
    endsOn: string
    itemCost: string
    taskNote: string
    perDayTech: { dow: number; techId: string; techName: string }[]
    flags: Record<string, string>
  }
}): Intake<IonTaskForm> & { shapeChanges?: string[] } {
  const { fields, detail } = parsed
  const refuse = (why: string) => ({ ok: false as const, failed: why, raw: fields })

  const shapeChanges: string[] = []
  for (const name of Object.keys(fields)) {
    if (!EXPECTED.has(name) && !IGNORED_PREFIXES.some((p) => name.startsWith(p))) {
      shapeChanges.push(`unexpected field: ${name}`)
    }
  }
  for (const name of ["EventID", "CustomerID", "ServiceRepeat", "InvoiceType", "StartsOn"]) {
    if (!(name in fields)) shapeChanges.push(`missing field: ${name}`)
  }

  if (!detail.ionTaskId) return refuse("form carries no EventID")
  const startsOn = normalizeIonDate(detail.startsOn)
  if (startsOn === "invalid") return refuse(`unparseable StartsOn "${detail.startsOn}"`)
  const endsOn = normalizeIonDate(detail.endsOn)
  if (endsOn === "invalid") return refuse(`unparseable EndsOn "${detail.endsOn}"`)
  const itemCostCents = centsFrom(detail.itemCost)
  if (itemCostCents === "invalid") return refuse(`unparseable itemcost "${detail.itemCost}"`)

  const dayTechs: IonTaskForm["dayTechs"] = {}
  for (const d of detail.perDayTech) {
    dayTechs[d.dow as IonWeekday] = { techId: d.techId, techName: d.techName }
  }
  const on = (v: string | undefined) => v === "on" || v === "1" || v === "true" || v === "yes"

  const value: IonTaskForm = {
    eventId: detail.ionTaskId,
    customerId: detail.customerId,
    serviceType: { id: detail.serviceType.value, label: detail.serviceType.text },
    profile: { id: detail.profile.value, label: detail.profile.text },
    serviceRepeat: { id: detail.serviceRepeat.value, label: detail.serviceRepeat.text },
    invoiceType: { id: detail.invoiceType.value, label: detail.invoiceType.text },
    startsOn, endsOn, itemCostCents,
    note: detail.taskNote,
    dayTechs,
    assignedTechId: fields["AssignedTo"]?.trim() || null,
    flags: {
      sendLog: on(detail.flags["sendlog"]), sendConsumables: on(detail.flags["SendConsumables"]),
      sendTechNote: on(detail.flags["sendtechnote"]), sendFiles: on(detail.flags["SendFiles"]),
      imgRequired: on(detail.flags["imgRequired"]),
    },
    rawFields: fields,
  }
  return shapeChanges.length ? { ok: true, value, shapeChanges } : { ok: true, value }
}

/* ----------------------------- translation -------------------------------- */

/** Our frequency vocabulary. daily does not exist: it is 7x (RULED). */
export type Frequency =
  | { kind: "weekly"; timesPerWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { kind: "biweekly" } // parity NOT tagged here — routing interprets StartsOn (D6)
  | { kind: "monthly" }

/** Our program vocabulary — WHY the work exists, translated from ION's
 *  ServiceType label. Feeds Basis classification (standalone vs rider). */
export type Program = "maintenance" | "green_to_clean" | "one_time_clean" | "plaster_start_up" | "quality_control"

export interface TaskTranslation {
  ionTaskId: string
  ionCustomerId: string
  program: Program
  /** The stop type this ION task generates — ONE per task (ION's split). */
  stopType: StopType
  /** ION-side slice identity for write-back (with stopType): which task
   *  receives which stops. Profile MEANING lives on the service body. */
  ionProfileId: string
  schedule: {
    period: { startsOn: string | null; endsOn: string | null }
    frequency: Frequency
    /** The stops filling the quota. Weekly: from dayTechs. Biweekly/monthly:
     *  constructed — assignedTech on StartsOn's weekday. */
    stops: { weekday: IonWeekday; techId: string }[]
  }
  billing: {
    /** ONE answer: itemcost wins when populated, else the catalog governs. */
    priceCents: number | null
    /** The rule's inputs, kept so the answer is re-derivable forever. */
    inputs: { itemCostCents: number | null; serviceTypeId: string; serviceTypeLabel: string }
    billingType: "flat_rate" | "per_visit"
    invoiceStyle: "itemized" | "summary"
    consumables: "included" | "separate"
    sendConsumables: boolean
  }
  /** Saved for backfill; no consumer in this context (profile → service body). */
  retained: { profileId: string; profileLabel: string; note: string }
}

/** Data-grounded 2026-08-07 (617 verified tasks). CLOSED — an unknown label
 *  refuses the translation (kept as failed, replayable); "won't change" plus
 *  a tripwire beats "won't change" as an assumption. Flat rate collapses to
 *  summary (RULED). */
const INVOICE_TYPE_DECODE: Record<
  string,
  { billingType: "flat_rate" | "per_visit"; invoiceStyle: "itemized" | "summary"; consumables: "included" | "separate" }
> = {
  "Per Visit Summary (list consumables)": { billingType: "per_visit", invoiceStyle: "summary", consumables: "included" },
  "Per Visit Summary (separate consumables)": { billingType: "per_visit", invoiceStyle: "summary", consumables: "separate" },
  "Per Visit Itemized (list consumables)": { billingType: "per_visit", invoiceStyle: "itemized", consumables: "included" },
  "Per Visit Itemized (separate consumables)": { billingType: "per_visit", invoiceStyle: "itemized", consumables: "separate" },
  "Flat Rate (list consumables)": { billingType: "flat_rate", invoiceStyle: "summary", consumables: "included" },
  "Flat Rate (separate consumables)": { billingType: "flat_rate", invoiceStyle: "summary", consumables: "separate" },
}

/** ServiceType label → program. Data-grounded 2026-08-08 (18 live service
 *  types across the 528-agreement book); the same rule set as the DB's
 *  maintenance.task_category, translated to OUR vocabulary. CLOSED — an
 *  unknown label refuses (a new ION service type must be classified on
 *  purpose, never defaulted into "maintenance"). */
/** ServiceType label → the STOP TYPE it generates (RULED 2026-08-08): the
 *  work has kinds; ION's one-type-per-task split is ACL noise. SPA/FOUNTAIN
 *  are cleans of a different service BODY — body identity is the log
 *  module's concern, never the stop's. CLOSED; unknown refuses. */
export type StopType = "clean" | "chem_check"

export function stopTypeOf(serviceTypeLabel: string): StopType | null {
  const l = serviceTypeLabel.trim()
  if (/^CHEMICAL TESTING/i.test(l)) return "chem_check"
  return programOf(l) === null ? null : "clean"
}

export function programOf(serviceTypeLabel: string): Program | null {
  const l = serviceTypeLabel.trim()
  if (/^(QUALITY CONTROL|NO CHARGE)/i.test(l)) return "quality_control"
  if (/^GREEN POOL/i.test(l)) return "green_to_clean"
  if (/^ONE TIME CLEAN/i.test(l)) return "one_time_clean"
  if (/^PLASTER START UP/i.test(l)) return "plaster_start_up"
  if (/^(POOL MAINTENANCE|FLAT RATE|SPA CLEAN|FOUNTAIN CLEAN|CHEMICAL TESTING)/i.test(l)) return "maintenance"
  return null
}

const weekdayOfIso = (iso: string): IonWeekday =>
  new Date(`${iso}T00:00:00Z`).getUTCDay() as IonWeekday

/**
 * form → translation. Pure aside from the catalog lookup, injected so the
 * price rule returns its ONE answer at translation time while its inputs
 * stay recorded (a later catalog change never falsifies history).
 */
export function translateTask(
  form: IonTaskForm,
  catalogPriceCents: (serviceTypeId: string) => number | null,
): Intake<TaskTranslation> {
  const refuse = (why: string) => ({ ok: false as const, failed: why, raw: form.rawFields })

  const repeat = form.serviceRepeat.label.toLowerCase()
  const dayEntries = Object.entries(form.dayTechs) as unknown as [string, { techId: string }][]

  let frequency: Frequency
  let stops: TaskTranslation["schedule"]["stops"]
  if (/bi-?week/.test(repeat) || /every other week|every 2 week/.test(repeat)) {
    frequency = { kind: "biweekly" }
    stops = constructedStop(form, refuse.name)
  } else if (/month|every 4 week/.test(repeat)) {
    frequency = { kind: "monthly" }
    stops = constructedStop(form, refuse.name)
  } else if (/daily/.test(repeat)) {
    // daily = weekly 7x in another spelling (RULED): assigned tech, every day
    if (!form.assignedTechId && dayEntries.length === 0) {
      return refuse("daily repeat but no assigned tech and no day techs")
    }
    frequency = { kind: "weekly", timesPerWeek: 7 }
    stops = dayEntries.length === 7
      ? dayEntries.map(([d, t]) => ({ weekday: Number(d) as IonWeekday, techId: t.techId }))
      : ([0, 1, 2, 3, 4, 5, 6] as IonWeekday[]).map((weekday) => ({ weekday, techId: form.assignedTechId! }))
  } else if (/week/.test(repeat)) {
    const n = dayEntries.length
    if (n === 0) return refuse("weekly repeat with zero day techs filled")
    frequency = { kind: "weekly", timesPerWeek: Math.min(n, 7) as 1 | 2 | 3 | 4 | 5 | 6 | 7 }
    stops = dayEntries.map(([d, t]) => ({ weekday: Number(d) as IonWeekday, techId: t.techId }))
  } else {
    return refuse(`unknown ServiceRepeat "${form.serviceRepeat.label}"`)
  }
  if (stops.length === 0) return refuse("no stop could be constructed")

  const decoded = INVOICE_TYPE_DECODE[form.invoiceType.label.trim()]
  if (!decoded) return refuse(`unknown InvoiceType "${form.invoiceType.label}"`)

  const program = programOf(form.serviceType.label)
  if (!program) return refuse(`unknown ServiceType "${form.serviceType.label}" — classify it in programOf`)
  const stopType = stopTypeOf(form.serviceType.label)
  if (!stopType) return refuse(`unknown ServiceType "${form.serviceType.label}" — classify it in stopTypeOf`)

  return {
    ok: true,
    value: {
      ionTaskId: form.eventId,
      ionCustomerId: form.customerId,
      program,
      stopType,
      ionProfileId: form.profile.id,
      schedule: {
        period: { startsOn: form.startsOn, endsOn: form.endsOn },
        frequency,
        stops: stops.sort((a, b) => a.weekday - b.weekday),
      },
      billing: {
        priceCents: form.itemCostCents ?? catalogPriceCents(form.serviceType.id),
        inputs: { itemCostCents: form.itemCostCents, serviceTypeId: form.serviceType.id, serviceTypeLabel: form.serviceType.label },
        ...decoded,
        sendConsumables: form.flags.sendConsumables,
      },
      retained: { profileId: form.profile.id, profileLabel: form.profile.label, note: form.note },
    },
  }

  function constructedStop(f: IonTaskForm, _: string): TaskTranslation["schedule"]["stops"] {
    // biweekly/monthly: no per-day selects — the assigned tech serves
    // StartsOn's weekday. Both facts required; their absence refuses upstream.
    if (!f.assignedTechId || !f.startsOn) return []
    return [{ weekday: weekdayOfIso(f.startsOn), techId: f.assignedTechId }]
  }
}

/* --------------------------------- diff ----------------------------------- */

export interface TranslationDiff {
  /** frequency/period moved — the AGREEMENT's news (required pattern, B5). */
  requirement: boolean
  /** stops moved — ROUTING's news (placements are ours). */
  placements: boolean
  /** any billing axis or the resolved price moved — terms news. */
  billing: boolean
  detail: string[]
}

/** Section-level diff of two consecutive versions. Empty diff on identical
 *  meaning is the point: representation churn stays tier-1-only. */
export function diffTranslations(prev: TaskTranslation, next: TaskTranslation): TranslationDiff {
  const detail: string[] = []
  const j = (v: unknown) => JSON.stringify(v)

  const requirement =
    j(prev.schedule.frequency) !== j(next.schedule.frequency) ||
    j(prev.schedule.period) !== j(next.schedule.period)
  if (requirement) detail.push(`requirement: ${j(prev.schedule.frequency)}/${j(prev.schedule.period)} -> ${j(next.schedule.frequency)}/${j(next.schedule.period)}`)

  const placements = j(prev.schedule.stops) !== j(next.schedule.stops)
  if (placements) detail.push(`placements: ${j(prev.schedule.stops)} -> ${j(next.schedule.stops)}`)

  const billing = j(prev.billing) !== j(next.billing)
  if (billing) detail.push(`billing: ${j(prev.billing)} -> ${j(next.billing)}`)

  return { requirement, placements, billing, detail }
}
