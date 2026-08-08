/**
 * Translation contract self-check: `npx tsx lib/external/ion/translation-selfcheck.ts`
 * Pure. The fixtures are the rulings of 2026-08-07 — each check names one.
 */

import assert from "node:assert"
import {
  ionTaskFormFrom, translateTask, diffTranslations, normalizeIonDate,
  type IonTaskForm, type TaskTranslation,
} from "./task-translation"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const catalog = (id: string) => (id === "st-clean" ? 15000 : null)

const form = (over: Partial<IonTaskForm> = {}): IonTaskForm => ({
  eventId: "4471",
  customerId: "9655",
  serviceType: { id: "st-clean", label: "Weekly Cleaning" },
  profile: { id: "p1", label: "Residential" },
  serviceRepeat: { id: "1", label: "Weekly" },
  invoiceType: { id: "4", label: "Per Visit Summary (list consumables)" },
  startsOn: "2026-08-03", // a Monday
  endsOn: null,
  itemCostCents: null,
  note: "",
  dayTechs: { 2: { techId: "korey", techName: "Korey" } },
  assignedTechId: null,
  flags: { sendLog: true, sendConsumables: true, sendTechNote: false, sendFiles: false, imgRequired: false },
  rawFields: { EventID: "4471" },
  ...over,
})

const tx = (f: IonTaskForm): TaskTranslation => {
  const r = translateTask(f, catalog)
  assert.ok(r.ok, `expected ok, got: ${!r.ok ? r.failed : ""}`)
  return (r as { ok: true; value: TaskTranslation }).value
}

/* ------------------------------ frequency --------------------------------- */

check("weekly: Nx from filled dayTech count, stops from the selects", () => {
  const t = tx(form({ dayTechs: { 1: { techId: "a", techName: "A" }, 3: { techId: "b", techName: "B" }, 5: { techId: "a", techName: "A" } } }))
  assert.deepStrictEqual(t.schedule.frequency, { kind: "weekly", timesPerWeek: 3 })
  assert.deepStrictEqual(t.schedule.stops.map((s) => s.weekday), [1, 3, 5])
})

check("daily is weekly 7x in another spelling — assigned tech fans to every day (RULED)", () => {
  const t = tx(form({ serviceRepeat: { id: "9", label: "Daily" }, dayTechs: {}, assignedTechId: "korey" }))
  assert.deepStrictEqual(t.schedule.frequency, { kind: "weekly", timesPerWeek: 7 })
  assert.strictEqual(t.schedule.stops.length, 7)
  assert.ok(t.schedule.stops.every((s) => s.techId === "korey"))
})

check("the two daily spellings translate IDENTICALLY — representation churn is invisible", () => {
  const spellingA = tx(form({ serviceRepeat: { id: "9", label: "Daily" }, dayTechs: {}, assignedTechId: "korey" }))
  const all7 = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { techId: "korey", techName: "Korey" }]))
  const spellingB = tx(form({ serviceRepeat: { id: "1", label: "Weekly" }, dayTechs: all7, assignedTechId: null }))
  const d = diffTranslations(spellingA, spellingB)
  assert.ok(!d.requirement && !d.placements && !d.billing)
})

check("biweekly: stop CONSTRUCTED from assigned tech on StartsOn's weekday; parity NOT tagged (D6 — routing interprets)", () => {
  const t = tx(form({ serviceRepeat: { id: "2", label: "Bi-Weekly" }, dayTechs: {}, assignedTechId: "dana", startsOn: "2026-08-03" }))
  assert.deepStrictEqual(t.schedule.frequency, { kind: "biweekly" }) // no A/B here, ever
  assert.deepStrictEqual(t.schedule.stops, [{ weekday: 1, techId: "dana" }]) // Monday
})

check("monthly: same construction", () => {
  const t = tx(form({ serviceRepeat: { id: "4", label: "Every 4 Weeks" }, dayTechs: {}, assignedTechId: "dana", startsOn: "2026-08-05" }))
  assert.deepStrictEqual(t.schedule.frequency, { kind: "monthly" })
  assert.deepStrictEqual(t.schedule.stops, [{ weekday: 3, techId: "dana" }]) // Wednesday
})

/* ------------------------------- billing ---------------------------------- */

check("flat rate collapses to summary (RULED)", () => {
  const t = tx(form({ invoiceType: { id: "7", label: "Flat Rate (list consumables)" } }))
  assert.strictEqual(t.billing.billingType, "flat_rate")
  assert.strictEqual(t.billing.invoiceStyle, "summary")
  assert.strictEqual(t.billing.consumables, "included")
})

check("price is ONE answer: itemcost wins; else catalog; inputs recorded either way", () => {
  const explicit = tx(form({ itemCostCents: 18500 }))
  assert.strictEqual(explicit.billing.priceCents, 18500)
  const fromCatalog = tx(form({ itemCostCents: null }))
  assert.strictEqual(fromCatalog.billing.priceCents, 15000)
  assert.deepStrictEqual(fromCatalog.billing.inputs, { itemCostCents: null, serviceTypeId: "st-clean" })
})

/* ---------------------- failure is a stored state ------------------------- */

check("unknown InvoiceType refuses WITH the raw attached — replayable, never discarded", () => {
  const r = translateTask(form({ invoiceType: { id: "9", label: "Some New Option" } }), catalog)
  assert.ok(!r.ok && r.failed.includes("Some New Option") && r.raw.EventID === "4471")
})

check("unknown ServiceRepeat refuses the same way", () => {
  const r = translateTask(form({ serviceRepeat: { id: "x", label: "Fortnightly-ish" } }), catalog)
  assert.ok(!r.ok && r.failed.includes("Fortnightly-ish"))
})

check("biweekly with no assigned tech cannot construct a stop — refuses, not guesses", () => {
  const r = translateTask(form({ serviceRepeat: { id: "2", label: "Bi-Weekly" }, dayTechs: {}, assignedTechId: null }), catalog)
  assert.ok(!r.ok)
})

/* -------------------------------- factory --------------------------------- */

const parsed = (fields: Record<string, string>, over: Record<string, unknown> = {}) => ({
  fields,
  detail: {
    ionTaskId: fields["EventID"] ?? "", customerId: fields["CustomerID"] ?? "",
    serviceType: { value: "st", text: "Weekly Cleaning" }, profile: { value: "p", text: "Res" },
    serviceRepeat: { value: "1", text: "Weekly" }, invoiceType: { value: "4", text: "Per Visit Summary (list consumables)" },
    startsOn: "8/3/26", endsOn: "", itemCost: "$185.00", taskNote: "",
    perDayTech: [{ dow: 2, techId: "korey", techName: "Korey" }], flags: {},
    ...over,
  },
})

check("factory normalizes ION vocabulary: MM/DD/YY → ISO, dollars → cents", () => {
  const r = ionTaskFormFrom(parsed({ EventID: "4471", CustomerID: "9655", ServiceRepeat: "1", InvoiceType: "4", StartsOn: "8/3/26" }))
  assert.ok(r.ok)
  assert.strictEqual(r.value.startsOn, "2026-08-03")
  assert.strictEqual(r.value.itemCostCents, 18500)
})

check("an unparseable date refuses with the raw fields kept", () => {
  const r = ionTaskFormFrom(parsed({ EventID: "4471", StartsOn: "soon" }, { startsOn: "soon" }))
  assert.ok(!r.ok && r.raw.EventID === "4471")
})

check("a stranger field is a shape change — reported, not fatal, nothing guessed", () => {
  const r = ionTaskFormFrom(parsed({ EventID: "4471", CustomerID: "9655", ServiceRepeat: "1", InvoiceType: "4", StartsOn: "8/3/26", BrandNewIonField: "?" }))
  assert.ok(r.ok && r.shapeChanges?.some((s) => s.includes("BrandNewIonField")))
})

check("date edge: ISO passes through, empty is null (open-ended), not invalid", () => {
  assert.strictEqual(normalizeIonDate("2026-12-01"), "2026-12-01")
  assert.strictEqual(normalizeIonDate(""), null)
  assert.strictEqual(normalizeIonDate("12/1/2026"), "2026-12-01")
})

/* ---------------------------------- diff ----------------------------------- */

check("tech change diffs PLACEMENTS only — an agreement fact cannot exist for it (B5 by construction)", () => {
  const a = tx(form())
  const b = tx(form({ dayTechs: { 2: { techId: "dana", techName: "Dana" } } }))
  const d = diffTranslations(a, b)
  assert.ok(d.placements && !d.requirement && !d.billing)
})

check("price change diffs BILLING only", () => {
  const d = diffTranslations(tx(form({ itemCostCents: 18500 })), tx(form({ itemCostCents: 19500 })))
  assert.ok(d.billing && !d.requirement && !d.placements)
})

check("day-count change diffs REQUIREMENT and placements — the 2x→3x case", () => {
  const two = tx(form({ dayTechs: { 1: { techId: "a", techName: "A" }, 4: { techId: "a", techName: "A" } } }))
  const three = tx(form({ dayTechs: { 1: { techId: "a", techName: "A" }, 3: { techId: "a", techName: "A" }, 5: { techId: "a", techName: "A" } } }))
  const d = diffTranslations(two, three)
  assert.ok(d.requirement && d.placements)
})

check("an irrelevant raw change (stopPayFixed) is INVISIBLE here — tier-1 only", () => {
  const a = tx(form({ rawFields: { EventID: "4471", StopPayFixed: "10.00" } }))
  const b = tx(form({ rawFields: { EventID: "4471", StopPayFixed: "12.00" } }))
  const d = diffTranslations(a, b)
  assert.ok(!d.requirement && !d.placements && !d.billing)
})

/* ------------------------ planWrite (I-T8 at the border) ------------------- */

import { planWrite } from "./ion-write-plan"

const arrangementOf = (t: ReturnType<typeof tx>, over: Partial<{ stops: { weekday: number; techId: string }[]; billing: typeof t.billing }> = {}) => ({
  pattern: t.schedule.frequency, billing: over.billing ?? t.billing,
  period: t.schedule.period, stops: over.stops ?? [...t.schedule.stops], note: "",
})

check("planWrite: only tech values moved -> amend (same id predicted)", () => {
  const cur = tx(form())
  const p = planWrite(cur, arrangementOf(cur, { stops: [{ weekday: 2, techId: "dana" }] }), "2026-08-10")
  assert.strictEqual(p.kind, "amend")
})

check("planWrite: day-set moved -> supersede (the anchor's weekday must move)", () => {
  const cur = tx(form())
  const p = planWrite(cur, arrangementOf(cur, { stops: [{ weekday: 3, techId: "korey" }] }), "2026-08-10")
  assert.ok(p.kind === "supersede" && p.effectiveWeekOf === "2026-08-10")
})

check("planWrite: commercial moved -> supersede even with identical stops", () => {
  const cur = tx(form())
  const p = planWrite(cur, arrangementOf(cur, { billing: { ...cur.billing, priceCents: 21000 } }), "2026-08-10")
  assert.strictEqual(p.kind, "supersede")
})

check("planWrite: nothing moved -> none (no write leaves the building)", () => {
  const cur = tx(form())
  assert.strictEqual(planWrite(cur, arrangementOf(cur), "2026-08-10").kind, "none")
})

check("planWrite: compares against ION reality (the fresh translation), never our record", () => {
  // the input IS the translation — there is no way to hand it an agreement.
  // The type system is the fixture here; this check documents the intent.
  const cur = tx(form())
  assert.ok(planWrite(cur, arrangementOf(cur), "2026-08-10"))
})

/* --------------------------- schedule sweep -------------------------------- */

import { signaturesOf, diffSweep } from "./schedule-sweep"

check("sweep signatures: 4-week window makes parity observable", () => {
  const sigs = signaturesOf([
    { ionTaskId: "t1", ionCustId: "c", date: "2026-08-11", techName: "Korey" }, // Tue wk0
    { ionTaskId: "t1", ionCustId: "c", date: "2026-08-25", techName: "Korey" }, // Tue wk2
  ], "2026-08-10")
  assert.deepStrictEqual(sigs[0].firingWeeks, "0,2") // biweekly evidence, not inference
  assert.strictEqual(sigs[0].daySet, "2")
})

check("sweep detects the flip-war class: two mirror slots cannot both match one reality", () => {
  const observed = signaturesOf(
    [{ ionTaskId: "deen", ionCustId: "c", date: "2026-08-14", techName: "Dana" }], "2026-08-10")
  const mirrored = [{ ionTaskId: "deen", daySet: "4,5", techSet: "Dana", firingWeeks: "0", eventCount: 2 }]
  const d = diffSweep(observed, mirrored)
  assert.strictEqual(d.length, 1)
  assert.strictEqual(d[0].reason, "signature_moved") // -> form-fetch ticket, never a write
})

check("sweep: unknown task -> match-or-mint ticket; vanished task -> ended ticket", () => {
  const d = diffSweep(
    [{ ionTaskId: "new", daySet: "1", techSet: "A", firingWeeks: "0,1,2,3", eventCount: 4 }],
    [{ ionTaskId: "gone", daySet: "1", techSet: "A", firingWeeks: "0,1,2,3", eventCount: 4 }])
  assert.deepStrictEqual(d.map((x) => x.reason).sort(), ["missing_from_sweep", "unknown_to_mirror"])
})

console.log(`translation selfcheck: ${n} checks passed`)
