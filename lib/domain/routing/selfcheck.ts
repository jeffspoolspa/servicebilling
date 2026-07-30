/**
 * The invariants, as runnable assertions. `npx tsx lib/domain/routing/selfcheck.ts`
 *
 * Plain objects only — no database, no framework. That the whole domain can be
 * exercised this way is the point of keeping it free of infrastructure.
 */

import { strict as assert } from "node:assert"
import {
  Adoption,
  AdoptionBlocked,
  baseIdOf,
  Boundary,
  Circle,
  CostModel,
  DriveMatrix,
  Leg,
  firesOn,
  Pin,
  RouteFactory,
  Scenario,
  Quota,
  QuotaRuleError,
  RouteGeometry,
  cadence,
  dayIndex,
  type CadenceInterval,
  type OrderingConstraint,
  type Requirement,
  type Weekday,
} from "./index"
// The projection helpers are the classes' internal computation layer; the
// self-check exercises them directly, as internals are tested.
import { cycleWeeks, distinctRuns, groupIntoRoutes, healthOf, heaviestRun, runOf, stopLegs } from "./projections"

const W0 = 2900 // an arbitrary week; nothing depends on which
const geometry = new RouteGeometry()
let checks = 0
const check = (name: string, fn: () => void) => {
  fn()
  checks++
  console.log(`  ok  ${name}`)
}

function quotaOf(
  id: string,
  opts: Partial<Requirement> & { requiredDays?: number; intervalWeeks?: CadenceInterval } = {},
): Quota {
  return new Quota({
    quotaId: id,
    customerId: 1,
    pin: Pin.hypothetical(31.14, -81.39),
    intervalWeeks: opts.intervalWeeks ?? 1,
    anchorWeek: opts.anchorWeek ?? 0,
    requiredDays: opts.requiredDays ?? 1,
    serviceMinutes: opts.serviceMinutes ?? null,
    orderingConstraint: (opts.orderingConstraint ?? "none") as OrderingConstraint,
    startWeek: opts.startWeek ?? W0,
    endWeek: opts.endWeek ?? null,
    ...opts,
  })
}

console.log("\nI1–I3 — structure")

check("a stop cannot exist without a tech", () => {
  const q = quotaOf("q1")
  assert.throws(() => q.place("", 2 as Weekday), QuotaRuleError)
})

check("I2: the same quota cannot be placed twice on one tech-day", () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  assert.throws(() => q.place("korey", 2 as Weekday), QuotaRuleError)
  assert.equal(q.stops.length, 1)
})

check("the same quota may sit on two different tech-days", () => {
  const q = quotaOf("q1", { requiredDays: 2 })
  q.place("korey", 1 as Weekday)
  q.place("jayden", 4 as Weekday)
  assert.equal(q.stops.length, 2)
})

console.log("\nI4 — coverage")

check("a quota with no stops fails coverage", () => {
  const c = quotaOf("q1").coverage()
  assert.equal(c.met, false)
  assert.deepEqual([c.required, c.placed], [1, 0])
})

check("a 2x/week quota with one stop fails, with two passes", () => {
  const q = quotaOf("q1", { requiredDays: 2 })
  q.place("korey", 1 as Weekday)
  assert.equal(q.coverage().met, false)
  q.place("korey", 4 as Weekday)
  assert.equal(q.coverage().met, true)
})

console.log("\nI5 — spacing")

check("Mon+Thu passes, Mon+Tue fails", () => {
  const good = quotaOf("good", { requiredDays: 2 })
  good.place("korey", 1 as Weekday)
  good.place("korey", 4 as Weekday)
  assert.equal(good.spacing().met, true, "Mon+Thu should pass")

  const bad = quotaOf("bad", { requiredDays: 2 })
  bad.place("korey", 1 as Weekday)
  bad.place("korey", 2 as Weekday)
  assert.equal(bad.spacing().met, false, "Mon+Tue should fail")
})

check("the wrap-around catches Sat+Sun", () => {
  const q = quotaOf("q1", { requiredDays: 2 })
  q.place("korey", 6 as Weekday) // Sat
  q.place("korey", 0 as Weekday) // Sun
  assert.equal(q.spacing().met, false)
})

check("a single firing has no gaps to judge", () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  assert.equal(q.spacing().met, true)
})

console.log("\ncadence")

check("weekly fires every week, biweekly alternates, monthly every fourth", () => {
  assert.equal(firesOn(cadence(1, W0), W0 + 3), true)
  assert.equal(firesOn(cadence(2, W0), W0 + 1), false)
  assert.equal(firesOn(cadence(2, W0), W0 + 2), true)
  assert.equal(firesOn(cadence(4, W0), W0 + 4), true)
  assert.equal(firesOn(cadence(4, W0), W0 + 2), false)
})

check("the anchor survives a negative offset", () => {
  assert.equal(firesOn(cadence(2, W0), W0 - 2), true)
  assert.equal(firesOn(cadence(2, W0), W0 - 1), false)
})

check("day indices give real day gaps", () => {
  assert.equal(dayIndex(W0, 4 as Weekday) - dayIndex(W0, 1 as Weekday), 3) // Mon→Thu
})

console.log("\nI11 — lifecycle")

check("placements end when the quota ends", () => {
  const q = quotaOf("q1", { endWeek: W0 + 2 })
  q.place("korey", 2 as Weekday)
  q.endIfExpired(W0 + 1)
  assert.equal(q.stops.length, 1, "still live")
  q.endIfExpired(W0 + 3)
  assert.equal(q.stops.length, 0, "expired")
  assert.equal(q.pullEvents().filter((e) => e.kind === "StopRemoved").length, 1)
})

console.log("\nI12 — history")

check("changes emit events and pulling clears them", () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  q.move({ techId: "korey", weekday: 2 as Weekday }, { techId: "dana", weekday: 4 as Weekday })
  const kinds = q.pullEvents().map((e) => e.kind)
  assert.deepEqual(kinds, ["StopPlaced", "StopMoved"])
  assert.equal(q.pullEvents().length, 0)
})

check("rehydration records nothing — no decision was made", () => {
  const q = Quota.rehydrate(quotaOf("q1").requirement, [{ techId: "korey", weekday: 2 as Weekday }])
  assert.equal(q.stops.length, 1)
  assert.equal(q.pullEvents().length, 0)
})

console.log("\nI6 — ordering")

check("first and last are honoured, the middle is geographic", () => {
  const at = (lng: number, c: OrderingConstraint = "none") => ({
    pin: Pin.hypothetical(31.2, lng),
    orderingConstraint: c,
    id: lng,
  })
  const ordered = geometry.order([at(-81.1), at(-81.5, "last"), at(-81.3), at(-81.9, "first")])
  assert.equal(ordered[0].id, -81.9, "first stays first")
  assert.equal(ordered[ordered.length - 1].id, -81.5, "last stays last")
})

check("an unpinned stop never breaks ordering", () => {
  const ordered = geometry.order([
    { pin: null, orderingConstraint: "none" as OrderingConstraint },
    { pin: Pin.hypothetical(31.2, -81.4), orderingConstraint: "none" as OrderingConstraint },
  ])
  assert.equal(ordered.length, 2)
})

console.log("\nprojections")

check("routes fall out of grouping by tech and weekday", () => {
  const a = quotaOf("a")
  a.place("korey", 2 as Weekday)
  const b = quotaOf("b")
  b.place("korey", 2 as Weekday)
  const c = quotaOf("c")
  c.place("dana", 2 as Weekday)
  const routes = groupIntoRoutes([a, b, c])
  assert.equal(routes.length, 2)
  assert.equal(routes.find((r) => r.techId === "korey")!.stops.length, 2)
})

check("the cycle is the LCM of the intervals present", () => {
  assert.equal(cycleWeeks([quotaOf("a")]), 1)
  assert.equal(cycleWeeks([quotaOf("a"), quotaOf("b", { intervalWeeks: 2 })]), 2)
  assert.equal(cycleWeeks([quotaOf("a"), quotaOf("b", { intervalWeeks: 4 })]), 4)
})

check("the worked example: 12 weekly + 2 biweekly-A + 1 biweekly-B + 1 two-a-week", () => {
  const quotas: Quota[] = []
  for (let i = 0; i < 12; i++) {
    const q = quotaOf(`weekly-${i}`)
    q.place("korey", 2 as Weekday)
    quotas.push(q)
  }
  for (const id of ["bell", "diaz"]) {
    const q = quotaOf(id, { intervalWeeks: 2, anchorWeek: W0 }) // week A parity
    q.place("korey", 2 as Weekday)
    quotas.push(q)
  }
  const cruz = quotaOf("cruz", { intervalWeeks: 2, anchorWeek: W0 + 1 }) // week B parity
  cruz.place("korey", 2 as Weekday)
  quotas.push(cruz)

  const oglethorpe = quotaOf("oglethorpe", { requiredDays: 2 })
  oglethorpe.place("korey", 2 as Weekday)
  oglethorpe.place("jayden", 5 as Weekday) // a different route entirely
  quotas.push(oglethorpe)

  const routes = groupIntoRoutes(quotas)
  const korey = routes.find((r) => r.techId === "korey" && r.weekday === 2)!
  assert.equal(korey.stops.length, 16, "route membership")

  const runs = distinctRuns(korey, W0, cycleWeeks(quotas), geometry)
  assert.equal(runs.length, 2, "two distinct runs")
  const sizes = runs.map((r) => r.stops.length).sort((x, y) => y - x)
  assert.deepEqual(sizes, [15, 14], "week A fires 15, week B fires 14")
  assert.equal(heaviestRun(runs)!.stops.length, 15)

  assert.equal(routes.find((r) => r.techId === "jayden")!.stops.length, 1, "the second stop is elsewhere")
})

console.log("\nhealth")

check("a stop far from its route's centre is flagged, a near one is not", () => {
  const near: Quota[] = []
  for (let i = 0; i < 4; i++) {
    const q = new Quota({ ...quotaOf(`n${i}`).requirement, pin: Pin.hypothetical(31.14 + i * 0.01, -81.39) })
    q.place("korey", 2 as Weekday)
    near.push(q)
  }
  const far = new Quota({ ...quotaOf("far").requirement, pin: Pin.hypothetical(32.05, -81.1) })
  far.place("korey", 2 as Weekday)

  const route = groupIntoRoutes([...near, far])[0]
  const flagged = healthOf(route, geometry).filter((h) => h.health === "far_from_route")
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].stop.quotaId, "far")
})

check("an unpinned stop is unpinned, never far", () => {
  const q = new Quota({ ...quotaOf("u").requirement, pin: null })
  q.place("korey", 2 as Weekday)
  const [only] = healthOf(groupIntoRoutes([q])[0], geometry)
  assert.equal(only.health, "unpinned")
})

check("a coordinate outside the service area cannot become a Pin", () => {
  assert.equal(Pin.fromTrusted({ lat: 40.7, lng: -74.0, status: "ok", placeId: "x" }), null)
  assert.equal(Pin.fromTrusted({ lat: 31.2, lng: -81.4, status: "needs_review", placeId: "x" }), null)
  assert.equal(Pin.fromTrusted({ lat: 31.2, lng: -81.4, status: "ok", placeId: null }), null)
  assert.notEqual(Pin.fromTrusted({ lat: 31.2, lng: -81.4, status: "ok", placeId: "x" }), null)
})

console.log("\nper-stop drive")

check("legs and marginal miles behave: sums match, detours cost", () => {
  // Three pins on a line west→east, then one far to the north mid-route.
  const mk = (id: string, lat: number, lng: number) => {
    const q = new Quota({ ...quotaOf(id).requirement, pin: Pin.hypothetical(lat, lng) })
    q.place("korey", 2 as Weekday)
    return q
  }
  const quotas = [mk("a", 31.2, -81.6), mk("b", 31.2, -81.5), mk("detour", 31.5, -81.45), mk("c", 31.2, -81.4)]
  const route = groupIntoRoutes(quotas)[0]
  const run = runOf(route, W0, geometry)
  const legs = stopLegs(run, geometry)

  for (const l of legs) assert.ok((l.marginalMi ?? 0) >= 0, "marginal miles are never negative")
  const worst = legs.reduce((m, l) => ((l.marginalMi ?? 0) > (m.marginalMi ?? 0) ? l : m))
  assert.equal(worst.stop.quotaId, "detour", "the detour stop carries the largest marginal miles")

  // Interior legs are shared: each fromPrev equals the previous stop's toNext.
  for (let i = 1; i < legs.length; i++) assert.equal(legs[i].fromPrevMi, legs[i - 1].toNextMi)
  assert.equal(legs[0].fromPrevMi, null)
  assert.equal(legs[legs.length - 1].toNextMi, null)
})

console.log("\nproximity")

check("nearest quotas come back closest-first and never include self or unpinned", () => {
  const at = (id: string, lng: number, pin = true) => {
    const q = new Quota({
      ...quotaOf(id).requirement,
      pin: pin ? Pin.hypothetical(31.2, lng) : null,
    })
    return q
  }
  const quotas = [at("me", -81.5), at("near", -81.51), at("far", -81.9), at("nopin", -81.5, false)]
  const near = geometry.nearest(quotas, "me", 10)
  assert.deepEqual(near.map((n) => n.quotaId), ["near", "far"])
  assert.ok(near[0].miles < near[1].miles)
  assert.ok(near[0].driveMinutes > 0)
})

check("the distance matrix is symmetric with a zero diagonal", () => {
  const at = (id: string, lng: number) =>
    new Quota({ ...quotaOf(id).requirement, pin: Pin.hypothetical(31.2, lng) })
  const m = geometry.pairwiseMiles([at("a", -81.5), at("b", -81.4), at("c", -81.6)])
  assert.equal(m.quotaIds.length, 3)
  for (let i = 0; i < 3; i++) {
    assert.equal(m.miles[i][i], 0)
    for (let j = 0; j < 3; j++) assert.equal(m.miles[i][j], m.miles[j][i])
  }
})

console.log("\nroute class")

check("the factory constructs Routes whose methods match the free functions", () => {
  const quotas: Quota[] = []
  for (let i = 0; i < 12; i++) {
    const q = quotaOf(`weekly-${i}`)
    q.place("korey", 2 as Weekday)
    quotas.push(q)
  }
  const bi = quotaOf("bi", { intervalWeeks: 2, anchorWeek: W0 })
  bi.place("korey", 2 as Weekday)
  quotas.push(bi)

  const factory = new RouteFactory(geometry)
  const route = factory.routeFor(quotas, "korey", 2 as Weekday, W0)!
  assert.equal(route.stops.length, 13)
  assert.equal(route.runs().length, 2, "weekly + one biweekly = two distinct runs")
  assert.equal(route.heaviest().stops.length, 13)
  assert.equal(route.runs(), route.runs(), "measurements are memoized — same object back")

  const profile = route.profileOf("bi")!
  assert.equal(profile.runs.length, 1, "the biweekly stop appears in one distinct run")
  assert.ok(profile.runs[0].marginalMi !== null)
  assert.equal(route.profileOf("not-here"), null)
})

console.log("\nscenario")

check("edits stay in the scenario; the live quotas never move", () => {
  const live = quotaOf("q1")
  live.place("korey", 2 as Weekday)
  live.pullEvents()

  const scenario = Scenario.from([live])
  scenario.moveStop("q1", { techId: "korey", weekday: 2 as Weekday }, { techId: "dana", weekday: 4 as Weekday })

  assert.equal(live.stops[0].techId, "korey", "live plan untouched")
  assert.equal(scenario.stopsOf("q1")[0].techId, "dana", "scenario changed")
  assert.equal(live.pullEvents().length, 0, "no events leaked to the live aggregate")
})

check("routes re-derive from scenario state, and only the touched ones differ", () => {
  const a = quotaOf("a"); a.place("korey", 2 as Weekday)
  const b = quotaOf("b"); b.place("korey", 2 as Weekday)
  const c = quotaOf("c"); c.place("dana", 4 as Weekday)
  const factory = new RouteFactory(geometry)

  const scenario = Scenario.from([a, b, c])
  scenario.moveStop("b", { techId: "korey", weekday: 2 as Weekday }, { techId: "dana", weekday: 4 as Weekday })

  assert.equal(scenario.routeFor(factory, "korey", 2 as Weekday, W0)!.stops.length, 1)
  assert.equal(scenario.routeFor(factory, "dana", 4 as Weekday, W0)!.stops.length, 2)
  assert.deepEqual(
    scenario.affectedRoutes().map((r) => `${r.techId}|${r.weekday}`).sort(),
    ["dana|4", "korey|2"],
  )
})

check("the change list IS the edits, and invariants hold inside the what-if", () => {
  const a = quotaOf("a", { requiredDays: 2 })
  a.place("korey", 2 as Weekday)
  a.place("dana", 4 as Weekday)
  a.pullEvents()
  const scenario = Scenario.from([a])
  scenario.moveStop("a", { techId: "korey", weekday: 2 as Weekday }, { techId: "korey", weekday: 3 as Weekday })
  assert.throws(
    () => scenario.moveStop("a", { techId: "korey", weekday: 3 as Weekday }, { techId: "dana", weekday: 4 as Weekday }),
    QuotaRuleError,
    "I2 holds inside a scenario: a quota cannot land on its own other stop",
  )
  const kinds = scenario.changes().map((e) => e.kind)
  assert.deepEqual(kinds, ["StopMoved"], "failed edits record nothing")
})

check("adoption is blocked while a touched quota breaks its own rules", () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  const scenario = Scenario.from([q])
  scenario.unplaceStop("q1", "korey", 2 as Weekday)
  const blockers = scenario.adoptionBlockers()
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].rule, "coverage")
  scenario.placeStop("q1", "dana", 4 as Weekday)
  assert.equal(scenario.adoptionBlockers().length, 0, "re-placing clears the blocker")
})

console.log("\nadoption")

check("an Adoption cannot exist for a blocked or empty scenario, and it stamps I12", () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  q.pullEvents()

  const empty = Scenario.from([q])
  assert.throws(() => Adoption.of(empty, "reroute-1"), /nothing to adopt/)

  const blocked = Scenario.from([q])
  blocked.unplaceStop("q1", "korey", 2 as Weekday)
  assert.throws(() => Adoption.of(blocked, "reroute-1"), AdoptionBlocked)

  const clean = Scenario.from([q])
  clean.moveStop("q1", { techId: "korey", weekday: 2 as Weekday }, { techId: "dana", weekday: 4 as Weekday })
  const adoption = Adoption.of(clean, "reroute-1")
  assert.equal(adoption.changes.length, 1)
  assert.equal(adoption.changes[0].scenarioId, "reroute-1", "every event carries the scenario id")
})

check("adopt is double dispatch: gate first, dry-run by default, port receives stamped events", async () => {
  const q = quotaOf("q1")
  q.place("korey", 2 as Weekday)
  q.pullEvents()
  const scenario = Scenario.from([q])
  scenario.moveStop("q1", { techId: "korey", weekday: 2 as Weekday }, { techId: "dana", weekday: 4 as Weekday })

  const calls: Array<{ n: number; dryRun: boolean; scenarioId?: string }> = []
  const publisher = {
    async publish(events: readonly import("./events").RoutingEvent[], opts: { dryRun: boolean }) {
      calls.push({ n: events.length, dryRun: opts.dryRun, scenarioId: events[0]?.scenarioId })
      return events.map((e) => ({ quotaId: e.quotaId, accepted: true, detail: "fake" }))
    },
  }

  const results = await scenario.adopt(publisher, "reroute-1")
  assert.deepEqual(calls, [{ n: 1, dryRun: true, scenarioId: "reroute-1" }], "dry run unless told otherwise")
  assert.equal(results[0].accepted, true)

  const blocked = Scenario.from([q])
  blocked.unplaceStop("q1", "korey", 2 as Weekday)
  await assert.rejects(() => blocked.adopt(publisher, "reroute-2"), AdoptionBlocked)
  assert.equal(calls.length, 1, "a blocked scenario never reaches the publisher")
})

console.log("\nfitting")

check("the backlog is a computed absence: unmetCount, never placeholder stops", () => {
  const q = quotaOf("q1", { requiredDays: 3 })
  q.place("korey", 1 as Weekday)
  assert.equal(q.unmetCount(), 2)
  assert.equal(q.stops.length, 1, "no phantom stops materialise")
  q.place("korey", 4 as Weekday)
  q.place("korey", 5 as Weekday)
  assert.equal(q.unmetCount(), 0)
})

check("fit ranks the geographically near route first and excludes routes already serving the quota", () => {
  const factory = new RouteFactory(geometry)
  const mkRoute = (tech: string, day: Weekday, lats: number[]) =>
    lats.map((lat, i) => {
      const q = new Quota({ ...quotaOf(`${tech}-${i}`).requirement, pin: Pin.hypothetical(lat, -81.4) })
      q.place(tech, day)
      return q
    })
  const near = mkRoute("dana", 4 as Weekday, [31.19, 31.2, 31.21, 31.22])
  const far = mkRoute("wes", 1 as Weekday, [32.1, 32.11, 32.12, 32.13])
  const mover = new Quota({ ...quotaOf("mover").requirement, pin: Pin.hypothetical(31.205, -81.41) })
  mover.place("korey", 2 as Weekday)

  const all = [...near, ...far, mover]
  const candidates = geometry.fit(factory.territory(all, W0), mover, 8)
  assert.equal(candidates[0].techId, "dana", "nearest cluster wins")
  assert.ok(candidates[0].insertionMi < candidates.find((c) => c.techId === "wes")!.insertionMi)
  assert.ok(!candidates.some((c) => c.weekday === 2), "every occupied weekday excluded, not just the own route (I5)")
  assert.ok(candidates[0].newUtilization > 0)
})

check("clear a route: quotas surface on the unplaced layer, adoption blocks, refit clears it", () => {
  const factory = new RouteFactory(geometry)
  const quotas: Quota[] = []
  for (let i = 0; i < 3; i++) {
    const q = new Quota({ ...quotaOf(`k${i}`).requirement, pin: Pin.hypothetical(31.2 + i * 0.01, -81.4) })
    q.place("korey", 2 as Weekday)
    q.pullEvents()
    quotas.push(q)
  }
  const d = new Quota({ ...quotaOf("d0").requirement, pin: Pin.hypothetical(31.21, -81.41) })
  d.place("dana", 4 as Weekday)
  d.pullEvents()
  quotas.push(d)

  const scenario = Scenario.from(quotas)
  assert.equal(scenario.clearRoute("korey", 2 as Weekday), 3)
  assert.equal(scenario.unplacedQuotas().length, 3, "cleared quotas surface as unplaced")
  assert.ok(scenario.unplacedQuotas().every((q) => q.requirement.pin !== null), "still drawable: pins are requirement-side")
  assert.equal(scenario.adoptionBlockers().filter((b) => b.rule === "coverage").length, 3, "adoption blocked")

  for (const q of scenario.unplacedQuotas()) {
    const best = geometry.fit(scenario.routes(factory, W0), q, 1)[0]
    scenario.placeStop(q.id, best.techId, best.weekday as Weekday)
  }
  assert.equal(scenario.unplacedQuotas().length, 0)
  assert.equal(scenario.adoptionBlockers().length, 0, "refit clears the gate")
  assert.equal(scenario.changes().length, 6, "3 removals + 3 placements — the full story, recorded")
})

check("the unplaced layer partitions: displaced quotas keep their memory, backlog stays backlog", () => {
  const k = new Quota({ ...quotaOf("k0").requirement, pin: Pin.hypothetical(31.2, -81.4) })
  k.place("korey", 2 as Weekday)
  k.pullEvents()
  const never = new Quota({ ...quotaOf("never").requirement, pin: Pin.hypothetical(31.3, -81.5) })

  const scenario = Scenario.from([k, never])
  scenario.clearRoute("korey", 2 as Weekday)

  const layer = scenario.unplacedLayer()
  assert.equal(layer.displaced.length, 1)
  assert.equal(layer.displaced[0].quota.id, "k0")
  assert.deepEqual(
    { techId: layer.displaced[0].from[0].techId, weekday: layer.displaced[0].from[0].weekday },
    { techId: "korey", weekday: 2 },
    "the event remembers exactly where it came from",
  )
  assert.equal(layer.backlog.length, 1)
  assert.equal(layer.backlog[0].id, "never")

  scenario.placeStop("k0", "dana", 4 as Weekday)
  const after = scenario.unplacedLayer()
  assert.equal(after.displaced.length, 0, "re-placing consumes the displacement")
  assert.equal(after.backlog.length, 1, "the backlog is untouched by it")
})

console.log("\ntransition seams")

check("Carter's example: sliding a monthly one week early makes a 3-week gap, not 4", () => {
  // Monthly firing on the W0 pattern (W0, W0+4, ...). It last fired W0+4.
  const q = quotaOf("m1", { intervalWeeks: 4, anchorWeek: W0 })
  q.place("korey", 2 as Weekday)
  q.pullEvents()

  // At W0+5, slide it to the pattern one week earlier in the cycle: fires W0+3, W0+7...
  const report = q.shiftAnchor(W0 + 3, W0 + 5)
  assert.deepEqual(
    { expected: report.expectedGapWeeks, actual: report.actualGapWeeks, anomalous: report.anomalous },
    { expected: 4, actual: 3, anomalous: true },
    "next visit lands 3 weeks after the last instead of 4",
  )
  assert.equal(q.pullEvents()[0].kind, "AnchorShifted")
})

check("a biweekly A→B flip seams by one week; a no-op shift does not seam", () => {
  const bi = quotaOf("b1", { intervalWeeks: 2, anchorWeek: W0 })
  bi.place("korey", 2 as Weekday)
  const flipped = bi.shiftAnchor(W0 + 1, W0)
  assert.equal(flipped.anomalous, true)
  assert.ok(flipped.actualGapWeeks === 1 || flipped.actualGapWeeks === 3)

  const same = quotaOf("b2", { intervalWeeks: 2, anchorWeek: W0 })
  same.place("korey", 2 as Weekday)
  const noop = same.shiftAnchor(W0 + 2, W0) // same parity — same pattern
  assert.equal(noop.anomalous, false)
})

check("in a scenario, a shift marks every route the quota rides as affected", () => {
  const q = quotaOf("m1", { intervalWeeks: 2, anchorWeek: W0, requiredDays: 2 })
  q.place("korey", 2 as Weekday)
  q.place("dana", 4 as Weekday)
  q.pullEvents()
  const scenario = Scenario.from([q])
  const report = scenario.shiftAnchor("m1", W0 + 1, W0)
  assert.equal(report.anomalous, true)
  assert.deepEqual(
    scenario.affectedRoutes().map((r) => `${r.techId}|${r.weekday}`).sort(),
    ["dana|4", "korey|2"],
  )
})

check("revision tracks edits, so a reader keyed on it cannot go stale", () => {
  const q = quotaOf("q1", { requiredDays: 2 })
  q.place("korey", 1 as Weekday)
  q.pullEvents()
  const scenario = Scenario.from([q])
  const initialChanges = scenario.changes()
  assert.equal(scenario.revision, 0)
  scenario.placeStop("q1", "dana", 4 as Weekday)
  const currentChanges = scenario.changes()
  assert.equal(scenario.revision, 1)
  assert.notEqual(currentChanges, initialChanges, "change reads are snapshots, not the mutable event buffer")
  assert.equal(initialChanges.length, 0, "an earlier snapshot does not mutate after a later edit")
  assert.equal(currentChanges.length, 1)
  try {
    scenario.placeStop("q1", "dana", 4 as Weekday) // I2 refuses
  } catch {
    /* expected */
  }
  assert.equal(scenario.revision, 1, "a refused edit changes nothing, including the revision")
})

check("replay reconstitutes a scenario, and dropping one change rebuilds without it", () => {
  const a = quotaOf("a"); a.place("korey", 1 as Weekday); a.pullEvents()
  const b = quotaOf("b"); b.place("korey", 1 as Weekday); b.pullEvents()
  const live = [a, b]

  const original = Scenario.from(live)
  original.moveStop("a", { techId: "korey", weekday: 1 as Weekday }, { techId: "dana", weekday: 3 as Weekday })
  original.moveStop("b", { techId: "korey", weekday: 1 as Weekday }, { techId: "dana", weekday: 4 as Weekday })
  assert.equal(original.revision, 2)

  const same = Scenario.replay(live, original.changes())
  assert.equal(same.revision, 2)
  assert.deepEqual(same.stopsOf("a"), original.stopsOf("a"), "replay reproduces the scenario exactly")
  assert.deepEqual(same.stopsOf("b"), original.stopsOf("b"))

  // Drop the first change: b still moves, a stays where it started.
  const without = Scenario.replay(live, original.changes().filter((_, i) => i !== 0))
  assert.equal(without.revision, 1)
  assert.equal(without.stopsOf("a")[0].techId, "korey", "the dropped change is gone")
  assert.equal(without.stopsOf("b")[0].techId, "dana", "the kept change survives")

  assert.equal(a.stops[0].techId, "korey", "the live quotas were never touched by any of it")
})

check("a boundary contains pins by ray casting, concave shapes included", () => {
  assert.throws(() => Boundary.of([{ lat: 31, lng: -81 }, { lat: 32, lng: -81 }]), /three points/)

  const square = Boundary.of([
    { lat: 31.0, lng: -81.6 },
    { lat: 31.4, lng: -81.6 },
    { lat: 31.4, lng: -81.2 },
    { lat: 31.0, lng: -81.2 },
  ])
  assert.equal(square.contains(Pin.hypothetical(31.2, -81.4)), true, "centre is inside")
  assert.equal(square.contains(Pin.hypothetical(31.2, -81.9)), false, "west of it is outside")
  assert.equal(square.contains(Pin.hypothetical(31.8, -81.4)), false, "north of it is outside")

  // A C-shape: the notch must read as outside, which a bounding box would miss.
  const cShape = Boundary.of([
    { lat: 31.0, lng: -81.6 },
    { lat: 31.4, lng: -81.6 },
    { lat: 31.4, lng: -81.2 },
    { lat: 31.3, lng: -81.2 },
    { lat: 31.3, lng: -81.5 },
    { lat: 31.1, lng: -81.5 },
    { lat: 31.1, lng: -81.2 },
    { lat: 31.0, lng: -81.2 },
  ])
  assert.equal(cShape.contains(Pin.hypothetical(31.05, -81.55)), true, "in the solid part")
  assert.equal(cShape.contains(Pin.hypothetical(31.2, -81.3)), false, "in the notch, so outside")
})

check("a circle contains pins within its radius, and its ring is that radius out", () => {
  const centre = Pin.hypothetical(31.2, -81.4)
  assert.throws(() => Circle.of(centre, 0), /positive radius/)

  const c = Circle.of(centre, 10)
  assert.equal(c.contains(centre), true, "the centre is inside")
  assert.equal(c.contains(Pin.hypothetical(31.28, -81.4)), true, "~5.5mi north is inside")
  assert.equal(c.contains(Pin.hypothetical(31.5, -81.4)), false, "~21mi north is outside")

  // Drawn across a diameter: both ends land ON the edge, not at the centre.
  const a = Pin.hypothetical(31.2, -81.4)
  const b = Pin.hypothetical(31.4, -81.4)
  const spanned = Circle.acrossDiameter(a, b)
  assert.ok(Math.abs(spanned.centre.lat - 31.3) < 1e-9, "centre is the midpoint")
  assert.ok(
    Math.abs(spanned.radiusMi - a.distanceTo(b) / 2) < 1e-9,
    "radius is half the span",
  )
  assert.ok(Math.abs(spanned.centre.distanceTo(a) - spanned.radiusMi) < 1e-6, "anchor is on the edge")
  assert.ok(Math.abs(spanned.centre.distanceTo(b) - spanned.radiusMi) < 1e-6, "cursor is on the edge")
  assert.throws(() => Circle.acrossDiameter(a, a), /positive radius/)

  // Every ring point sits on the boundary, so the drawn outline matches what
  // containment actually tests — the bug this guards is a ring drawn with a
  // different constant than the one distance uses.
  for (const p of c.ring(24)) {
    const d = centre.distanceTo(Pin.hypothetical(p.lat, p.lng))
    assert.ok(Math.abs(d - 10) < 0.2, `ring point ${d.toFixed(2)}mi from centre, expected 10`)
  }
})

check("placementsWithin selects by the quota's pin, narrowed by weekday", () => {
  const inside = quotaOf("in", { pin: Pin.hypothetical(31.2, -81.4) })
  inside.place("korey", 1 as Weekday)
  inside.place("korey", 4 as Weekday)
  const outside = quotaOf("out", { pin: Pin.hypothetical(30.1, -81.4) })
  outside.place("korey", 1 as Weekday)
  const unplaced = quotaOf("unplaced", { pin: Pin.hypothetical(31.2, -81.35) })

  const scenario = Scenario.from([inside, outside, unplaced])
  const box = Boundary.of([
    { lat: 31.0, lng: -81.6 },
    { lat: 31.4, lng: -81.6 },
    { lat: 31.4, lng: -81.2 },
    { lat: 31.0, lng: -81.2 },
  ])

  // A circle over the same area selects the same stops — selection is
  // shape-agnostic, which is the point of Region.
  assert.deepEqual(
    scenario.placementsWithin([Circle.of(Pin.hypothetical(31.2, -81.4), 20)]).map((p) => p.quotaId),
    ["in", "in"],
  )

  // Overlapping regions dedupe: the same pool inside both is still one pool.
  assert.deepEqual(
    scenario
      .placementsWithin([
        Circle.of(Pin.hypothetical(31.2, -81.4), 20),
        Circle.of(Pin.hypothetical(31.21, -81.41), 20),
      ])
      .map((p) => p.quotaId),
    ["in", "in"],
    "two stops, not four",
  )

  const all = scenario.placementsWithin([box])
  assert.equal(all.length, 2, "both of the inside quota's stops; none of the outside one's")
  assert.ok(all.every((p) => p.quotaId === "in"))
  assert.equal(
    all.some((p) => p.quotaId === "unplaced"),
    false,
    "a quota inside the shape with no stops contributes no placements",
  )

  const tuesdayOnly = scenario.placementsWithin([box], [4 as Weekday])
  assert.equal(tuesdayOnly.length, 1)
  assert.equal(tuesdayOnly[0].weekday, 4)
})

check("reassign moves a selection and reports what it skipped", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.2, -81.4) })
  a.place("korey", 1 as Weekday)
  const b = quotaOf("b", { pin: Pin.hypothetical(31.2, -81.4) })
  b.place("korey", 1 as Weekday)
  b.place("dana", 3 as Weekday)
  const c = quotaOf("c", { pin: Pin.hypothetical(31.2, -81.4) })
  c.place("dana", 3 as Weekday)

  const scenario = Scenario.from([a, b, c])
  const selection = [
    { quotaId: "a", techId: "korey", weekday: 1 as Weekday },
    { quotaId: "b", techId: "korey", weekday: 1 as Weekday },
    { quotaId: "c", techId: "dana", weekday: 3 as Weekday },
  ]
  const report = scenario.reassign(selection, "dana", 3 as Weekday)

  assert.equal(report.moved.length, 1, "only a actually moves")
  assert.equal(report.moved[0].quotaId, "a")
  assert.equal(report.skipped.length, 2)
  assert.equal(
    report.skipped.find((s) => s.quotaId === "b")?.reason,
    "already served on that day",
    "b's Monday stop cannot move onto dana/3 — b is already there",
  )
  assert.equal(report.skipped.find((s) => s.quotaId === "c")?.reason, "already there")

  assert.equal(scenario.revision, 1, "a skip records no change")
  assert.deepEqual(
    scenario.stopsOf("b").map((s) => `${s.techId}|${s.weekday}`).sort(),
    ["dana|3", "korey|1"],
    "the skipped quota is untouched, not half-moved",
  )
  assert.equal(a.stops[0].techId, "korey", "live quotas untouched")
})

console.log("\ndrive matrix")

check("the matrix is the one measurer: warm-started or memoizing, same legs", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4) })
  const b = quotaOf("b", { pin: Pin.hypothetical(31.1, -81.3) })
  const c = quotaOf("c", { pin: Pin.hypothetical(31.2, -81.4) })

  const warm = DriveMatrix.of([a, b, c])
  assert.equal(warm.size, 3, "three pins, three pairs")

  const lazy = new DriveMatrix()
  assert.equal(lazy.size, 0)
  const direct = a.requirement.pin!.distanceTo(b.requirement.pin!)
  const viaWarm = warm.milesBetween("a", "b", a.requirement.pin!, b.requirement.pin!)
  const viaLazy = lazy.milesBetween("a", "b", a.requirement.pin!, b.requirement.pin!)
  assert.equal(viaWarm, direct, "warm lookup is the same measurement")
  assert.equal(viaLazy, direct, "lazy measures the same and memoizes")
  assert.equal(lazy.size, 1, "the miss was recorded")
  assert.equal(
    lazy.milesBetween("b", "a", b.requirement.pin!, a.requirement.pin!),
    direct,
    "symmetric key: b→a hits a→b's entry",
  )
  assert.equal(lazy.size, 1, "no duplicate entry for the reverse direction")

  // A quota added later joins as part of its first measurement.
  const late = quotaOf("late", { pin: Pin.hypothetical(31.05, -81.35) })
  warm.add(late)
  assert.equal(warm.size, 6, "one new quota, three new pairs")
})

check("estimates are identical with a warm matrix — the matrix changes speed, not answers", () => {
  const quotas = [
    quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4) }),
    quotaOf("b", { pin: Pin.hypothetical(31.1, -81.3) }),
    quotaOf("c", { pin: Pin.hypothetical(31.2, -81.4) }),
  ]
  for (const q of quotas) q.place("korey", 1 as Weekday)

  const bare = new RouteFactory(new RouteGeometry()).routeFor(quotas, "korey", 1 as Weekday, W0)!
  const warm = new RouteFactory(
    new RouteGeometry(undefined, DriveMatrix.of(quotas)),
  ).routeFor(quotas, "korey", 1 as Weekday, W0)!
  assert.deepEqual(warm.heaviest().estimate, bare.heaviest().estimate)
  assert.deepEqual(
    warm.runs()[0].legs.map((l) => l.marginalMi),
    bare.runs()[0].legs.map((l) => l.marginalMi),
    "stop legs agree too",
  )
})

check("a Leg is made by the matrix and carries road miles and minutes", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4) })
  const b = quotaOf("b", { pin: Pin.hypothetical(31.1, -81.4) })
  const m = DriveMatrix.of([a, b])
  const leg = m.legBetween("a", "b", a.requirement.pin!, b.requirement.pin!, 1.3, 32)
  assert.ok(leg instanceof Leg)
  assert.equal(leg.fromQuotaId, "a")
  const straight = a.requirement.pin!.distanceTo(b.requirement.pin!)
  assert.ok(Math.abs(leg.miles - straight * 1.3) < 0.06, "road miles = straight × detour")
  assert.ok(Math.abs(leg.minutes - (leg.miles / 32) * 60) < 0.5, "minutes follow policy mph")
})

check("measured road legs replace estimates, direction by direction", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4), serviceMinutes: 30 })
  a.place("korey", 1 as Weekday)
  const b = quotaOf("b", { pin: Pin.hypothetical(31.1, -81.4), serviceMinutes: 30 })
  b.place("korey", 1 as Weekday)

  const matrix = DriveMatrix.of([a, b])
  const g = new RouteGeometry(undefined, matrix)
  const factory = new RouteFactory(g)
  const before = factory.routeFor([a, b], "korey", 1 as Weekday, W0)!.heaviest().estimate

  // The engine reports the two directions differently — one-ways exist.
  matrix.learn([
    { fromId: "a", toId: "b", minutes: 25, miles: 12 },
    { fromId: "b", toId: "a", minutes: 18, miles: 10 },
  ])
  assert.equal(matrix.realMinutesBetween("a", "b"), 25)
  assert.equal(matrix.realMinutesBetween("b", "a"), 18, "asymmetry is representable")
  assert.equal(matrix.realMinutesBetween("a", "c"), null, "unmeasured stays null")

  const after = new RouteFactory(g).routeFor([a, b], "korey", 1 as Weekday, W0)!.heaviest().estimate
  assert.notEqual(after.driveMinutes, before.driveMinutes, "the estimate now uses the measurement")
  assert.equal(after.driveMinutes, 25, "a→b measured at 25 (tour runs a then b, no base)")
  assert.equal(after.driveMi, 12, "measured road miles replace straight × detour")
  assert.ok(matrix.hasMeasured(["a", "b"]))
  assert.ok(!matrix.hasMeasured(["a", "c"]))
})

check("stems price on measured legs too, through the base pseudo-id", () => {
  const q = quotaOf("solo", { pin: Pin.hypothetical(31.2, -81.4), serviceMinutes: 30 })
  q.place("korey", 1 as Weekday)
  const base = Pin.hypothetical(31.0, -81.4)
  const matrix = DriveMatrix.of([q])
  const g = new RouteGeometry(undefined, matrix)
  matrix.learn([
    { fromId: baseIdOf(base), toId: "solo", minutes: 31, miles: 17 },
    { fromId: "solo", toId: baseIdOf(base), minutes: 29, miles: 16 },
  ])
  const factory = new RouteFactory(g, new Map([["korey", base]]))
  const est = factory.routeFor([q], "korey", 1 as Weekday, W0)!.heaviest().estimate
  assert.equal(est.driveMinutes, 60, "out 31 + back 29, both measured")
  assert.equal(est.driveMi, 33)
})

console.log("\nstems — the office is part of the drive")

check("a run pays its stems: base to first stop, last stop back", () => {
  const q = quotaOf("solo", { pin: Pin.hypothetical(31.2, -81.4) })
  q.place("korey", 1 as Weekday)
  const base = Pin.hypothetical(31.0, -81.4) // ~13.8mi south
  const factory = new RouteFactory(geometry, new Map([["korey", base]]))
  const route = factory.routeFor([q], "korey", 1 as Weekday, W0)!
  const est = route.heaviest().estimate
  const stem = base.distanceTo(q.requirement.pin!)
  assert.ok(Math.abs(est.driveMi - stem * 2 * 1.3) < 0.2, "one stop costs the round trip")

  const bare = new RouteFactory(geometry).routeFor([q], "korey", 1 as Weekday, W0)!
  assert.equal(bare.heaviest().estimate.driveMi, 0, "without a base the same route prices at zero — the old undercount")
})

check("every stop has a from and a to: the tour's ends are office legs", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.2, -81.4) })
  a.place("korey", 1 as Weekday)
  const b = quotaOf("b", { pin: Pin.hypothetical(31.25, -81.4) })
  b.place("korey", 1 as Weekday)
  const base = Pin.hypothetical(31.0, -81.4)
  const factory = new RouteFactory(geometry, new Map([["korey", base]]))
  const legs = factory.routeFor([a, b], "korey", 1 as Weekday, W0)!.heaviest().legs
  assert.ok(legs[0].fromPrevMi !== null && legs[0].fromPrevMi > 10, "first stop arrives from the office")
  assert.ok(legs[legs.length - 1].toNextMi !== null, "last stop returns to the office")
})

check("inserting into an empty day costs the round trip from the office", () => {
  const base = Pin.hypothetical(31.0, -81.4)
  const pin = Pin.hypothetical(31.2, -81.4)
  const cost = geometry.cheapestInsertionMi([], pin, base)
  assert.ok(Math.abs(cost - base.distanceTo(pin) * 2) < 0.2)
  assert.equal(geometry.cheapestInsertionMi([], pin), 0, "no base, no stem to pay — the understatement")
})

check("consolidation pays off: one tech in the cluster beats three driving out — the bug Carter caught", () => {
  // Three pools ~0.6mi apart, 14mi from the office; three techs each serve one.
  // Every tech pays the ~28mi round trip for a single pool.
  const base = Pin.hypothetical(31.0, -81.4)
  const p1 = quotaOf("p1", { pin: Pin.hypothetical(31.2, -81.4) })
  p1.place("t1", 1 as Weekday)
  const p2 = quotaOf("p2", { pin: Pin.hypothetical(31.21, -81.4) })
  p2.place("t2", 1 as Weekday)
  const p3 = quotaOf("p3", { pin: Pin.hypothetical(31.2, -81.39) })
  p3.place("t3", 1 as Weekday)
  const bases = new Map([["t1", base], ["t2", base], ["t3", base]])
  const factory = new RouteFactory(geometry, bases)
  const model = new CostModel(geometry, factory)

  const analysis = model.analyze([p1, p2, p3], [
    { kind: "StopMoved", quotaId: "p2", from: { techId: "t2", weekday: 1 as Weekday }, to: { techId: "t1", weekday: 1 as Weekday } },
    { kind: "StopMoved", quotaId: "p3", from: { techId: "t3", weekday: 1 as Weekday }, to: { techId: "t1", weekday: 1 as Weekday } },
  ], W0)

  for (const m of analysis.moves) {
    assert.ok(m.exactNetMinutes < -30, `each consolidation frees a round trip (got ${m.exactNetMinutes})`)
    assert.ok(m.removalGainMi > 25, "the removal gain is the freed stem")
    assert.ok(m.insertionCostMi < 3, "the insertion is a hop inside the cluster")
  }
  assert.ok(analysis.netMinutes < -80, "two freed round trips, minus two short hops")
})

console.log("\ncost model")

check("estimate charges each stop its own median, defaults where history is thin", () => {
  const a = quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4), serviceMinutes: 35 })
  a.place("korey", 1 as Weekday)
  const b = quotaOf("b", { pin: Pin.hypothetical(31.1, -81.4) }) // no history → policy 22
  b.place("korey", 1 as Weekday)
  const route = new RouteFactory(geometry).routeFor([a, b], "korey", 1 as Weekday, W0)!
  const est = route.heaviest().estimate
  assert.equal(est.serviceMinutes, 57, "35 observed + 22 default")
  assert.ok(Math.abs(est.minutes - (est.driveMinutes + est.serviceMinutes)) < 0.11)
  assert.ok(est.windshield > 0 && est.windshield < 1)
  assert.ok(Math.abs(est.windshield - est.driveMinutes / est.minutes) < 0.01)
})

check("route cost averages over the cycle, so a biweekly stop weighs half", () => {
  const weekly = quotaOf("w", { pin: Pin.hypothetical(31.0, -81.4), serviceMinutes: 30 })
  weekly.place("korey", 1 as Weekday)
  const biweekly = quotaOf("bi", {
    pin: Pin.hypothetical(31.0, -81.4), // same pin: no drive, pure service arithmetic
    intervalWeeks: 2,
    anchorWeek: 0,
    serviceMinutes: 40,
  })
  biweekly.place("korey", 1 as Weekday)
  const model = new CostModel(geometry)
  const route = new RouteFactory(geometry).routeFor([weekly, biweekly], "korey", 1 as Weekday, W0)!
  const cost = model.ofRoute(route)
  assert.equal(cost.stops, 2)
  // cycle of 2: one week costs 30+40, the other 30 → (70+30)/2
  assert.equal(cost.weeklyServiceMinutes, 50)
  assert.equal(cost.weeklyDriveMi, 0)
  assert.equal(cost.windshield, 0, "no drive, all service")
})

check("analyze prices a move: removal gain, insertion cost, kind, exact delta", () => {
  // korey/Mon: A and C on a north-south line, B jutting east — dropping B
  // shortcuts the dogleg. dana/Wed: one stop D to the west.
  const A = quotaOf("A", { pin: Pin.hypothetical(31.0, -81.4) })
  A.place("korey", 1 as Weekday)
  const B = quotaOf("B", { pin: Pin.hypothetical(31.1, -81.3), serviceMinutes: 40 })
  B.place("korey", 1 as Weekday)
  const C = quotaOf("C", { pin: Pin.hypothetical(31.2, -81.4) })
  C.place("korey", 1 as Weekday)
  const D = quotaOf("D", { pin: Pin.hypothetical(31.05, -81.45) })
  D.place("dana", 3 as Weekday)
  const live = [A, B, C, D]
  const model = new CostModel(geometry)

  const move = { kind: "StopMoved" as const, quotaId: "B",
    from: { techId: "korey", weekday: 1 as Weekday }, to: { techId: "dana", weekday: 3 as Weekday } }
  const analysis = model.analyze(live, [move], W0)
  const m = analysis.moves[0]

  assert.equal(m.kind, "tech_day", "different tech AND different day")
  assert.ok(m.removalGainMi > 0, "dropping the dogleg saves miles")
  assert.ok(m.insertionCostMi > 0, "dana pays to reach B")
  assert.ok(Math.abs(m.netMi - (m.insertionCostMi - m.removalGainMi)) < 0.05)
  assert.equal(m.serviceMinutesShifted, 40, "B's own median moves with it")
  assert.equal(m.before.length, 2, "both affected routes appraised before")
  assert.equal(m.after.length, 2, "and after")
  // The exact delta agrees with re-derived route costs
  const sum = (rs: readonly { weeklyMinutes: number }[]) => rs.reduce((n, r) => n + r.weeklyMinutes, 0)
  assert.ok(Math.abs(m.exactNetMinutes - (sum(m.after) - sum(m.before))) < 0.05)
  assert.equal(analysis.disruption.tech_day, 1, "the kind is logged — day/tech changes have downstream effects")
  assert.equal(m.resistanceMinutes, 0, "resistance priced from policy — all zeros until elicited")
  assert.equal(analysis.resistanceMinutes, 0)

  // Live quotas untouched: analysis clones, never edits
  assert.equal(B.stops[0].techId, "korey")
})

check("sequential pricing telescopes: per-move exact deltas sum to the whole list's effect", () => {
  const A = quotaOf("A", { pin: Pin.hypothetical(31.0, -81.4) })
  A.place("korey", 1 as Weekday)
  const B = quotaOf("B", { pin: Pin.hypothetical(31.1, -81.3) })
  B.place("korey", 1 as Weekday)
  const C = quotaOf("C", { pin: Pin.hypothetical(31.2, -81.4) })
  C.place("korey", 1 as Weekday)
  const D = quotaOf("D", { pin: Pin.hypothetical(31.05, -81.45) })
  D.place("dana", 3 as Weekday)
  const live = [A, B, C, D]
  const model = new CostModel(geometry)
  const factory = new RouteFactory(geometry)
  const to = { techId: "dana", weekday: 3 as Weekday }
  const changes = [
    { kind: "StopMoved" as const, quotaId: "B", from: { techId: "korey", weekday: 1 as Weekday }, to },
    { kind: "StopMoved" as const, quotaId: "C", from: { techId: "korey", weekday: 1 as Weekday }, to },
  ]
  const analysis = model.analyze(live, changes, W0)

  // Direct measurement: both plans in full, same routes, no sequencing tricks.
  const costOf = (qs: readonly Quota[]) =>
    ["korey|1", "dana|3"]
      .map((k) => {
        const [t, d] = k.split("|")
        const r = factory.routeFor(qs, t, Number(d) as Weekday, W0)
        return r ? model.ofRoute(r).weeklyMinutes : 0
      })
      .reduce((a, b) => a + b, 0)
  const after = Scenario.replay(live, changes)
  const direct = costOf(after.all) - costOf(live)
  assert.ok(
    Math.abs(analysis.netMinutes - direct) <= 1,
    `telescoped ${analysis.netMinutes} vs direct ${direct}`,
  )
  assert.equal(analysis.moves.length, 2)
})

check("a nearby tech-swap keeps its sub-minute cost — the zero-cost bug", () => {
  // Two techs, same day, stops ~0.7mi apart: the true drive delta is well
  // under a minute. Integer rounding used to erase it to exactly 0.
  const a = quotaOf("a", { pin: Pin.hypothetical(31.0, -81.4) })
  a.place("korey", 1 as Weekday)
  const b = quotaOf("b", { pin: Pin.hypothetical(31.01, -81.4) })
  b.place("korey", 1 as Weekday)
  const c = quotaOf("c", { pin: Pin.hypothetical(31.05, -81.4) })
  c.place("dana", 1 as Weekday)
  const model = new CostModel(geometry)
  const analysis = model.analyze([a, b, c], [
    { kind: "StopMoved", quotaId: "b", from: { techId: "korey", weekday: 1 as Weekday }, to: { techId: "dana", weekday: 1 as Weekday } },
  ], W0)
  const m = analysis.moves[0]
  assert.equal(m.kind, "tech", "same day, different tech")
  assert.notEqual(m.exactNetMinutes, 0, "a real move has a real cost, even under a minute")
  assert.ok(Math.abs(m.exactNetMinutes) < 60)
})

check("place and unplace price one-sided", () => {
  const A = quotaOf("A", { pin: Pin.hypothetical(31.0, -81.4) })
  A.place("korey", 1 as Weekday)
  const B = quotaOf("B", { pin: Pin.hypothetical(31.1, -81.4), requiredDays: 1 })
  const model = new CostModel(geometry)

  const placed = model.analyze([A, B], [
    { kind: "StopPlaced", quotaId: "B", to: { techId: "korey", weekday: 1 as Weekday } },
  ], W0)
  assert.equal(placed.moves[0].kind, "place")
  assert.equal(placed.moves[0].removalGainMi, 0, "nothing to remove")
  assert.ok(placed.moves[0].exactNetMinutes > 0, "the plan takes on real work")

  const removed = model.analyze([A], [
    { kind: "StopRemoved", quotaId: "A", from: { techId: "korey", weekday: 1 as Weekday }, reason: "unplaced" },
  ], W0)
  assert.equal(removed.moves[0].kind, "unplace")
  assert.equal(removed.moves[0].insertionCostMi, 0, "nothing inserted")
  assert.ok(removed.moves[0].exactNetMinutes < 0, "the plan sheds its service time")
})

console.log(`\n${checks} checks passed\n`)
