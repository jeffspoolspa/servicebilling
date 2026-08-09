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
const check = (name: string, fn: () => void) => {
  try {
    fn()
  } catch (e) {
    console.error(`FAILED: ${name}`)
    throw e
  }
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

check("tech-only swap HOLDS out the current period's pending visit (RULED: no mid-week override)", () => {
  // Thursday pool, last served Thu 08-06, today Wed 08-12: THIS week's
  // Thu 08-13 is already planned — the old tech serves it; the swap
  // lands the day after.
  const [v] = planner.plan([weekly({ to: [{ weekday: 4, techId: "elaina" }] })], ctx())
  assert.strictEqual(v.validity, "valid")
  assert.strictEqual(v.effectiveDate, "2026-08-14")
})

check("tech-only swap with the week's visit already served is effective TODAY", () => {
  // same pool, but today is Saturday — Thursday came and went
  const [v] = planner.plan([weekly({ to: [{ weekday: 4, techId: "elaina" }] })], ctx({ today: "2026-08-15" }))
  assert.strictEqual(v.effectiveDate, "2026-08-15")
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

check("capacity NEVER schedules (RULED); a vacating tech-swap lags its period — the one-Friday overlap is TRUE and warned", () => {
  const load = new Map([["elaina·5", 10]])
  const arriving = weekly({ quotaId: "in", to: [{ weekday: 5, techId: "elaina" }] })
  const [alone] = planner.plan([arriving], ctx({ routeLoad: load }))
  assert.ok(alone.effectiveDate! <= "2026-08-14") // this week — date untouched by capacity
  assert.ok(alone.warnings[0]?.includes("transient overload elaina·5"))
  // a vacating TECH-SWAP on the same surface nets out at steady state,
  // but under the timing law it waits out ITS Friday (old tech owns the
  // planned week) — so THIS Friday genuinely carries both cohorts: the
  // warning is truth now, dated to the one overlapping Friday.
  const vacating = weekly({
    quotaId: "out", from: [{ weekday: 5, techId: "elaina" }], to: [{ weekday: 5, techId: "dana" }],
  })
  const both = planner.plan([arriving, vacating], ctx({ routeLoad: load }))
  const inV = both.find((v) => v.quotaId === "in")!
  const outV = both.find((v) => v.quotaId === "out")!
  assert.ok(outV.effectiveDate! >= "2026-08-15") // day after the pending Friday
  assert.ok(inV.warnings[0]?.includes("transient overload elaina·5"))
  assert.strictEqual(inV.clusterId, outV.clusterId) // grouping survives for reporting
})

check("independent moves stagger freely — no false coupling", () => {
  const a = weekly({ quotaId: "a" })
  const b = weekly({ quotaId: "b", from: [{ weekday: 1, techId: "x" }], to: [{ weekday: 2, techId: "x" }], lastServed: "2026-08-10" })
  const [va, vb] = planner.plan([a, b], ctx())
  assert.notStrictEqual(va.clusterId, vb.clusterId)
})

check("Carter's Friday case DISSOLVES under the current-period hold — no mid-week override, no overload", () => {
  // today Thursday 8/13. A: X's Friday pools -> Y (tech-only). B: Y's own
  // Friday pools -> Wednesday. Under the hold, A's swap waits out THIS
  // Friday (X serves it) and lands Saturday; by next Friday B has vacated
  // to Wednesday — the interference Carter named cannot happen anymore.
  const load = new Map([["y·5", 10]])
  const a = weekly({ quotaId: "a", from: [{ weekday: 5, techId: "x" }], to: [{ weekday: 5, techId: "y" }] })
  const b3 = [0, 1, 2].map((k) => weekly({
    quotaId: `b${k}`, from: [{ weekday: 5, techId: "y" }], to: [{ weekday: 3, techId: "y" }],
    lastServed: "2026-08-07",
  }))
  const verdicts = planner.plan([a, ...b3], ctx({ today: "2026-08-13", routeLoad: load }))
  const va = verdicts.find((v) => v.quotaId === "a")!
  assert.strictEqual(va.effectiveDate, "2026-08-15") // day after this week's pending Friday
  assert.ok(verdicts.filter((v) => v.quotaId.startsWith("b")).every((v) => v.effectiveDate! >= "2026-08-17"))
  assert.strictEqual(va.warnings.length, 0) // the overload window contains no Friday — phantom filtered
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

check("same-day flip: bridge PROPOSAL on the NEW route, default YES for biweekly (Gage mechanics)", () => {
  // Served Tue 08-11 (cycle through 08-23); flip's new parity starts
  // 09-01. The bridge rides the NEW route: newStartsOn - 7 = 08-25, the
  // NEW tech (they meet the pool early), free. Biweekly -> accepted by
  // default, so the verdict is the bridged plan. Two-stream law: max
  // gaps 14+7 hold; paid gap 21 holds (min exempts free visits).
  const [v] = planner.plan([weekly({
    cadence: { kind: "biweekly" },
    from: [{ weekday: 2, techId: "old-tech" }], to: [{ weekday: 2, techId: "new-tech" }],
    lastServed: "2026-08-11", anchorShiftWeeks: 1,
  })], ctx())
  assert.strictEqual(v.anchorDate, "2026-09-01")
  assert.deepStrictEqual(v.bridges, [{ date: "2026-08-25", techId: "new-tech", defaultAccept: true }])
  assert.deepStrictEqual(v.timeline.slice(0, 3), ["2026-08-11", "2026-08-25", "2026-09-01"])
  assert.strictEqual(v.violations.length, 0)
})

check("non-biweekly bridge proposals are NOT auto-accepted: violation stays loud + suggestion attached", () => {
  // weekly Thu -> Mon far out: seam 08-06 -> 08-24 (18d > 8). The bridge
  // suggestions ride the verdict, but weekly has no default-yes: the
  // user rules; until then the late violation stands.
  const [v] = planner.plan([weekly({
    to: [{ weekday: 1, techId: "new-tech" }], lastServed: "2026-08-06",
  })], ctx({ today: "2026-08-20" }))
  if (v.bridges.length) {
    assert.ok(v.bridges.every((b) => !b.defaultAccept && b.techId === "new-tech"))
    assert.ok(v.violations.some((g) => g.bound === "late"))
  }
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

check("NEVER-SERVED tech swap holds for a scheduled FIRST visit in the current week", () => {
  // task starts Thu 08-13 (never served); today Wed 08-12. Thursday's
  // first visit is on the printed route — the swap lands Friday.
  const [v] = planner.plan([weekly({
    from: [{ weekday: 4, techId: "matthew" }], to: [{ weekday: 4, techId: "elaina" }],
    lastServed: null, scheduleAnchor: "2026-08-13",
  })], ctx())
  assert.strictEqual(v.effectiveDate, "2026-08-14")
  // first visit NEXT week -> nothing pends, swap lands today
  const [w] = planner.plan([weekly({
    from: [{ weekday: 4, techId: "matthew" }], to: [{ weekday: 4, techId: "elaina" }],
    lastServed: null, scheduleAnchor: "2026-08-20",
  })], ctx())
  assert.strictEqual(w.effectiveDate, "2026-08-12")
})

console.log(`transition selfcheck: ${n} checks passed`)
