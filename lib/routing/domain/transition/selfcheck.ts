/**
 * Transition self-check: `npx tsx lib/routing/domain/transition/selfcheck.ts`
 * Pure. Fixtures earned from the RH Current simulation (2026-08-08) plus
 * Carter's named cases.
 */

import assert from "node:assert"
import { checkCadenceLaw, gapBoundsFor } from "./cadence-law"
import { projectFirings } from "./project-firings"
import { TransitionPlanner, type MoveInput, type WeekContext } from "./transition-planner"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const planner = new TransitionPlanner()
// Wednesday 2026-08-12 as "today" — mid-week, the interesting cursor
const ctx = (over: Partial<WeekContext> = {}): WeekContext => ({
  today: "2026-08-12", routeLoad: new Map(), maxPoolsPerRoute: 10, ...over,
})
const weekly = (over: Partial<MoveInput> = {}): MoveInput => ({
  quotaId: "q1", cadence: { kind: "weekly", timesPerWeek: 1 },
  from: [{ weekday: 4, techId: "matthew" }], to: [{ weekday: 5, techId: "elaina" }],
  lastServed: "2026-08-06", ...over,
})

/* --------------------------- cadence law ---------------------------------- */

check("bounds are the RULED tightened windows: biweekly [10,14], weekly [5,8] — bridges absorb the seams", () => {
  assert.deepStrictEqual(gapBoundsFor({ kind: "biweekly" }), { loDays: 10, hiDays: 14, idealDays: 14 })
  assert.deepStrictEqual(gapBoundsFor({ kind: "weekly", timesPerWeek: 1 }), { loDays: 5, hiDays: 8, idealDays: 7 })
})

check("the law reads one stream — the seam is just the first gap", () => {
  const v = checkCadenceLaw(["2026-07-24", "2026-08-14"], gapBoundsFor({ kind: "biweekly" }))
  assert.strictEqual(v.length, 1)
  assert.ok(v[0].gapDays === 21 && v[0].bound === "late")
})

check("projectFirings: biweekly fires only on anchor-phase weeks", () => {
  const dates = projectFirings(
    { cadence: { kind: "biweekly" }, weekdays: [2], anchorDate: "2026-08-18" },
    "2026-08-10", "2026-09-20",
  )
  assert.deepStrictEqual(dates, ["2026-08-18", "2026-09-01", "2026-09-15"])
})

/* ----------------------- step 1: validity --------------------------------- */

check("coverage change is NEVER VALID here — the agreements road (the 106's StopRemoved)", () => {
  const [v] = planner.plan([weekly({ to: [] })], ctx())
  assert.strictEqual(v.validity, "never_valid")
  assert.ok(v.reasons[0].includes("agreements road"))
})

check("Carter's Tue/Wed 2x-week: spacing rejects at staging — no date can save it", () => {
  const [v] = planner.plan([weekly({
    cadence: { kind: "weekly", timesPerWeek: 2 },
    from: [{ weekday: 2, techId: "m" }, { weekday: 4, techId: "m" }],
    to: [{ weekday: 2, techId: "m" }, { weekday: 3, techId: "e" }],
  })], ctx())
  assert.strictEqual(v.validity, "never_valid")
  assert.ok(v.reasons[0].includes("spacing"))
})

/* --------------------- step 2: scheduling --------------------------------- */

check("tech-only move is effective TODAY — the 66 need no deferral", () => {
  const [v] = planner.plan([weekly({ to: [{ weekday: 4, techId: "elaina" }] })], ctx())
  assert.strictEqual(v.validity, "valid")
  assert.strictEqual(v.effectiveDate, "2026-08-12")
})

check("tech swap is never backward: Monday's tech changed on a SATURDAY -> today", () => {
  const [v] = planner.plan([weekly({
    from: [{ weekday: 1, techId: "matthew" }], to: [{ weekday: 1, techId: "elaina" }],
  })], ctx({ today: "2026-08-15" })) // Saturday
  assert.strictEqual(v.effectiveDate, "2026-08-15")
})

check("NoBackwardPlacement: Thursday→Monday on a Wednesday waits for next week", () => {
  const [v] = planner.plan([weekly({ to: [{ weekday: 1, techId: "matthew" }] })], ctx())
  // Monday of the current week is behind the cursor; earliest legal = next week
  assert.ok(v.effectiveDate! >= "2026-08-17")
})

check("Thursday→Friday on a Wednesday is legal THIS week — forward within the week", () => {
  const [v] = planner.plan([weekly()], ctx())
  assert.ok(v.effectiveDate! <= "2026-08-14")
  assert.strictEqual(v.violations.length, 0)
})

check("capacity NEVER schedules (RULED): over-cap arrival keeps its date, carries a WARNING", () => {
  const load = new Map([["elaina·5", 10]])
  const arriving = weekly({ quotaId: "in", to: [{ weekday: 5, techId: "elaina" }] })
  const [alone] = planner.plan([arriving], ctx({ routeLoad: load }))
  assert.ok(alone.effectiveDate! <= "2026-08-14") // this week — date untouched by capacity
  assert.ok(alone.warnings[0]?.includes("transient overload elaina·5"))
  // net composite: a vacating move on the same surface clears the warning
  const vacating = weekly({
    quotaId: "out", from: [{ weekday: 5, techId: "elaina" }], to: [{ weekday: 5, techId: "dana" }],
  })
  const both = planner.plan([arriving, vacating], ctx({ routeLoad: load }))
  const inV = both.find((v) => v.quotaId === "in")!
  assert.strictEqual(inV.warnings.length, 0) // net legal -> no warning
  assert.strictEqual(inV.clusterId, both.find((v) => v.quotaId === "out")!.clusterId) // grouping survives for reporting
})

check("independent moves stagger freely — no false coupling", () => {
  const a = weekly({ quotaId: "a" })
  const b = weekly({ quotaId: "b", from: [{ weekday: 1, techId: "x" }], to: [{ weekday: 2, techId: "x" }], lastServed: "2026-08-10" })
  const [va, vb] = planner.plan([a, b], ctx())
  assert.notStrictEqual(va.clusterId, vb.clusterId)
})

check("Carter's Friday case: staggered dates create a TRANSIENT overload — dated warning", () => {
  // today Thursday 8/13. A: X's Friday pools -> Y (tech-only, lands tomorrow).
  // B: Y's own Friday pools -> Wednesday (already passed -> next week).
  // End-state nets fine; THIS Friday Y carries both cohorts.
  const load = new Map([["y·5", 10]]) // includes B's three pools, still on Friday today
  const a = weekly({ quotaId: "a", from: [{ weekday: 5, techId: "x" }], to: [{ weekday: 5, techId: "y" }] })
  const b3 = [0, 1, 2].map((k) => weekly({
    quotaId: `b${k}`, from: [{ weekday: 5, techId: "y" }], to: [{ weekday: 3, techId: "y" }],
    lastServed: "2026-08-07",
  }))
  const verdicts = planner.plan([a, ...b3], ctx({ today: "2026-08-13", routeLoad: load }))
  const va = verdicts.find((v) => v.quotaId === "a")!
  assert.strictEqual(va.effectiveDate, "2026-08-13") // capacity never schedules
  assert.ok(verdicts.filter((v) => v.quotaId.startsWith("b")).every((v) => v.effectiveDate! >= "2026-08-17"))
  assert.ok(va.warnings[0]?.includes("transient overload y·5"))
  assert.ok(va.warnings[0]?.includes("2026-08-13→2026-08-17")) // dated: until B vacates
})

/* ------------------- parity derived at the seam --------------------------- */

check("biweekly day-move derives the phase honoring ~14d — the RH seam fix", () => {
  // last served Tue 2026-08-04; naive next-week Tuesday = 8/11 (7d, legal but
  // early); the planner should prefer ~14d -> anchor 2026-08-18
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "m" }], to: [{ weekday: 2, techId: "e" }],
    lastServed: "2026-08-04",
  })], ctx())
  assert.strictEqual(v.anchorDate, "2026-08-18")
  assert.strictEqual(v.violations.length, 0)
  assert.strictEqual(v.timeline[0], "2026-08-04")
})

check("A/B flip is VALID with a derived date — verdict and date are separate", () => {
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "m" }], to: [{ weekday: 2, techId: "m" }],
    lastServed: "2026-08-11", // just served — flip must wait out the gap
  })], ctx())
  assert.strictEqual(v.validity, "valid")
  assert.ok(v.anchorDate! >= "2026-08-21") // >=10d after last served (RULED lo bound)
  assert.strictEqual(v.violations.length, 0)
})

check("conservative policy: the blanket rule rides ON the machinery — Monday, verified", () => {
  const [v] = planner.plan([weekly({ to: [{ weekday: 4, techId: "elaina" }] })],
    ctx({ schedulingPolicy: "conservative" })) // tech-only, Wed cursor
  assert.strictEqual(v.effectiveDate, "2026-08-17") // next Monday, not today
  assert.strictEqual(v.violations.length, 0) // law still proves the seam
})

check("same-day flip: the CUT next-period visit returns as the bridge rider (Carter's Gage mechanics)", () => {
  // Served Tue 08-11 (cycle through 08-23). The flip's new parity starts
  // 09-01; next-period 08-25 is CUT by EndsOn — and comes back as the
  // free bridge rider on the SAME date. Two-stream law: max gaps 14+7
  // (all visits) hold; min gap 21 (paid only — 08-11 -> 09-01) holds;
  // the 7-day gap after a FREE visit is legal because the minimum
  // protects the paid cadence, not our generosity.
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "old-tech" }], to: [{ weekday: 2, techId: "old-tech" }],
    lastServed: "2026-08-11", anchorShiftWeeks: 1,
  })], ctx())
  assert.strictEqual(v.anchorDate, "2026-09-01")
  assert.deepStrictEqual(v.bridges, [{ date: "2026-08-25", techId: "old-tech" }])
  assert.deepStrictEqual(v.timeline.slice(0, 3), ["2026-08-11", "2026-08-25", "2026-09-01"])
  assert.strictEqual(v.violations.length, 0)
})

check("REQUESTED flip that cannot fit the window: scheduled at nearest target-parity date, VIOLATION reported", () => {
  // just served Tue 08-11; flip candidates on target parity: 08-11 week is
  // current parity so next odd week Tue is 08-25 -> gap 14? No: flip from
  // 08-11's parity -> target weeks are 08-18's parity... 08-18 gap 7 fits.
  // Force the impossible case with cursor pushing base past the window:
  // base = today 2026-08-12; last served 2026-07-20 (23 days before the
  // first target-parity Tuesday available) -> every candidate exceeds 20.
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "m" }], to: [{ weekday: 2, techId: "m" }],
    lastServed: "2026-07-20", anchorShiftWeeks: 1,
  })], ctx())
  assert.strictEqual(v.validity, "valid") // the move itself is legal
  assert.ok(v.violations.length >= 1) // but the seam breaches the law, loudly
  assert.strictEqual(v.violations[0].bound, "late")
})

check("PERIOD-CLEAR beats the bridge: the scheduled 08-11 visit fills the seam — no freebie needed", () => {
  // biweekly Tue -> Fri WITH a parity flip, last served Tue 07-28, cursor
  // Mon 08-10. Under the old cut-law this needed a free bridge; now the
  // old pattern's SCHEDULED Tue 08-11 clears (it was owed anyway) and
  // anchors the seam: 08-11 -> Fri 08-21 = 10 days, in window. Zero
  // bridges, zero deletions, zero violations.
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "old-tech" }], to: [{ weekday: 5, techId: "new-tech" }],
    lastServed: "2026-07-28", anchorShiftWeeks: 1,
  })], ctx({ today: "2026-08-10" }))
  assert.strictEqual(v.anchorDate, "2026-08-21")
  assert.deepStrictEqual(v.bridges, [])
  assert.deepStrictEqual(v.timeline.slice(0, 3), ["2026-07-28", "2026-08-11", "2026-08-21"])
  assert.strictEqual(v.violations.length, 0)
})

check("bridges only when they help: an unbridgeable seam keeps its LOUD violation", () => {
  // last served long ago — every old-phase candidate is behind the cursor,
  // so nothing can bridge; the violation must survive, loudly.
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "m" }], to: [{ weekday: 5, techId: "m" }],
    lastServed: "2026-07-07", anchorShiftWeeks: 1,
  })], ctx())
  assert.deepStrictEqual(v.bridges, [])
  assert.ok(v.violations.length >= 1)
})

console.log(`transition selfcheck: ${n} checks passed`)
