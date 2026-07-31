/**
 * Scenario — a proposed set of placements, edited in memory.
 *
 * Open one over live quotas and it clones them, so nothing you do here can
 * touch the live plan (I13). Move stops between routes and the affected
 * routes re-derive instantly, because routes were never stored to begin with.
 * Every edit goes through the cloned Quota aggregates, so the invariants
 * hold inside a what-if exactly as they do live — and every edit is recorded,
 * so the list of proposed changes is not tracked alongside the work, it IS
 * the work. Adoption is downstream: hand `changes()` to a publisher.
 */

import type { Placement, RoutingEvent } from "./events"
import type { PublishResult, RoutePublisher } from "./ports"
import { Quota, type Stop, type TransitionReport } from "./quota"
import { RouteFactory, Route } from "./route-factory"
import type { Region, Weekday, WeekIndex } from "./values"

/** One stop, identified well enough to move it: which quota, and where it sits. */
export interface SelectedStop {
  readonly quotaId: string
  readonly techId: string
  readonly weekday: Weekday
}

export interface ReassignReport {
  readonly moved: readonly SelectedStop[]
  readonly placed: readonly string[]
  readonly skipped: readonly { quotaId: string; reason: string }[]
}

/** What a drawn region caught: placements to move, and owed quotas to place. */
export interface RegionSelection {
  readonly stops: readonly SelectedStop[]
  /** Quota ids inside the region still owed placements — no stop exists yet. */
  readonly owed: readonly string[]
}

/** A stored change that no longer applies to today's plan. */
export interface InvalidChange {
  readonly change: RoutingEvent
  readonly reason: string
}

/**
 * A scenario reconstituted from storage: what replayed cleanly, and what the
 * live plan has moved out from under. A scenario is nothing but its change
 * list, so staleness is per-change — one dead change does not kill the rest.
 */
export interface RestoreReport {
  readonly scenario: Scenario
  readonly applied: readonly RoutingEvent[]
  readonly invalidated: readonly InvalidChange[]
}

export interface AdoptionBlocker {
  readonly quotaId: string
  readonly rule: "coverage" | "spacing"
  readonly detail: string
}

export class AdoptionBlocked extends Error {
  constructor(readonly blockers: readonly AdoptionBlocker[]) {
    super(`adoption blocked: ${blockers.map((b) => `${b.quotaId.slice(0, 8)} ${b.rule} (${b.detail})`).join("; ")}`)
  }
}

/**
 * A scenario's changes, cleared for publication. The Pin pattern applied to
 * adoption: this cannot be constructed from a blocked or empty scenario, so
 * "publish an unadoptable scenario" is unrepresentable rather than checked
 * for. Stamping the scenario id here is I12 — an invariant, not a courtesy
 * of whichever use case remembers to.
 */
export class Adoption {
  private constructor(
    readonly scenarioId: string,
    readonly changes: readonly RoutingEvent[],
  ) {}

  static of(scenario: Scenario, scenarioId: string): Adoption {
    const blockers = scenario.adoptionBlockers()
    if (blockers.length > 0) throw new AdoptionBlocked(blockers)
    const changes = scenario.changes()
    if (changes.length === 0) throw new Error("nothing to adopt: the scenario has no changes")
    return new Adoption(scenarioId, changes.map((e) => ({ ...e, scenarioId })))
  }
}

export class Scenario {
  private readonly quotas: Map<string, Quota>
  private readonly recorded: RoutingEvent[] = []

  private constructor(clones: readonly Quota[]) {
    this.quotas = new Map(clones.map((q) => [q.id, q]))
  }

  /** Clone the given quotas into an isolated workbench. */
  static from(live: readonly Quota[]): Scenario {
    return new Scenario(live.map((q) => Quota.rehydrate(q.requirement, q.stops)))
  }

  /**
   * Rebuild a scenario by replaying a change list over live quotas. A scenario
   * IS its base plus its changes, so this reconstitutes one exactly — which is
   * what lets a single change be dropped (replay without it) and what a saved
   * scenario would store. Throws if a change no longer applies, because live
   * data moving underneath should surface, not silently diverge.
   */
  static replay(live: readonly Quota[], changes: readonly RoutingEvent[]): Scenario {
    const scenario = Scenario.from(live)
    for (const e of changes) {
      if (e.kind === "StopPlaced") scenario.placeStop(e.quotaId, e.to.techId, e.to.weekday)
      else if (e.kind === "StopMoved") scenario.moveStop(e.quotaId, e.from, e.to)
      else if (e.kind === "StopRemoved") scenario.unplaceStop(e.quotaId, e.from.techId, e.from.weekday)
      else if (e.kind === "AnchorShifted") {
        const quota = scenario.quotas.get(e.quotaId)
        if (quota) scenario.edit(e.quotaId, (q) => q.shiftAnchor(e.toAnchorWeek, quota.requirement.startWeek))
      }
    }
    return scenario
  }

  /**
   * Lenient replay for stored scenarios: each change is tried against the
   * fresh plan, and one whose underlying stops have changed is invalidated
   * with its reason rather than sinking the whole list. `replay` (strict)
   * remains the right tool for same-session undo, where a failure is a bug.
   */
  static restore(live: readonly Quota[], changes: readonly RoutingEvent[]): RestoreReport {
    const scenario = Scenario.from(live)
    const applied: RoutingEvent[] = []
    const invalidated: InvalidChange[] = []
    for (const e of changes) {
      try {
        if (e.kind === "StopPlaced") scenario.placeStop(e.quotaId, e.to.techId, e.to.weekday)
        else if (e.kind === "StopMoved") scenario.moveStop(e.quotaId, e.from, e.to)
        else if (e.kind === "StopRemoved") scenario.unplaceStop(e.quotaId, e.from.techId, e.from.weekday)
        else {
          const quota = scenario.quotas.get(e.quotaId)
          if (!quota) throw new Error(`no quota ${e.quotaId} in the live plan`)
          scenario.edit(e.quotaId, (q) => q.shiftAnchor(e.toAnchorWeek, quota.requirement.startWeek))
        }
        applied.push(e)
      } catch (err) {
        invalidated.push({ change: e, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return { scenario, applied, invalidated }
  }

  /* ---------------------------------------------------------------- edits */

  moveStop(
    quotaId: string,
    from: { techId: string; weekday: Weekday },
    to: { techId: string; weekday: Weekday },
  ): void {
    this.edit(quotaId, (q) => q.move(from, to))
  }

  placeStop(quotaId: string, techId: string, weekday: Weekday): void {
    this.edit(quotaId, (q) => q.place(techId, weekday))
  }

  unplaceStop(quotaId: string, techId: string, weekday: Weekday): void {
    this.edit(quotaId, (q) => q.unplace(techId, weekday))
  }

  /**
   * Slide a quota to the other alternating week (biweekly A↔B, or a monthly
   * to a different week of the cycle). Returns the transition report: the
   * one-time seam this creates against the standing interval — advisory,
   * because an early or late single visit is a judgment, not a violation.
   */
  shiftAnchor(quotaId: string, toAnchorWeek: WeekIndex, asOfWeek: WeekIndex): TransitionReport {
    let report!: TransitionReport
    this.edit(quotaId, (q) => {
      report = q.shiftAnchor(toAnchorWeek, asOfWeek)
    })
    return report
  }

  /**
   * Clear a whole route: every quota with a stop on this (tech, weekday) loses
   * that placement. The quotas now fail coverage, which is the point — they
   * surface on the unplaced layer and block adoption until re-placed.
   */
  clearRoute(techId: string, weekday: Weekday): number {
    let cleared = 0
    for (const quota of this.quotas.values()) {
      if (quota.stops.some((s) => s.techId === techId && s.weekday === weekday)) {
        this.edit(quota.id, (q) => q.unplace(techId, weekday))
        cleared++
      }
    }
    return cleared
  }

  /**
   * Every placement whose quota's Pin falls inside any of the drawn regions,
   * optionally narrowed to certain weekdays.
   *
   * The Pin belongs to the quota, not the stop, so "which pools are in this
   * region" is answered once per quota and its stops follow. Weekday narrowing
   * is here rather than left to the caller because the answer differs — draw
   * round a neighbourhood on the Tuesday view and you mean its Tuesday stops,
   * not every stop those pools have.
   *
   * Takes a set of regions rather than one so overlapping shapes dedupe here:
   * a pool inside two circles is one pool, and the caller never has to merge.
   */
  placementsWithin(regions: readonly Region[], weekdays?: readonly Weekday[]): SelectedStop[] {
    const days = weekdays && weekdays.length > 0 ? new Set(weekdays) : null
    const out: SelectedStop[] = []
    for (const quota of this.quotas.values()) {
      const pin = quota.requirement.pin
      if (!pin || !regions.some((r) => r.contains(pin))) continue
      for (const stop of quota.stops) {
        if (days && !days.has(stop.weekday)) continue
        out.push({ quotaId: quota.id, techId: stop.techId, weekday: stop.weekday })
      }
    }
    return out
  }

  /**
   * Everything a drawn region catches: placements (optionally narrowed by
   * weekday) and quotas still owed placements. Owed quotas ignore the weekday
   * narrowing — they have no weekday yet, which is the point of catching them.
   */
  selectionWithin(regions: readonly Region[], weekdays?: readonly Weekday[]): RegionSelection {
    const stops = this.placementsWithin(regions, weekdays)
    const owed: string[] = []
    for (const quota of this.quotas.values()) {
      const pin = quota.requirement.pin
      if (!pin || quota.unmetCount() === 0) continue
      if (regions.some((r) => r.contains(pin))) owed.push(quota.id)
    }
    return { stops, owed }
  }

  /**
   * Move a selection of stops onto one (tech, weekday) in a single step.
   *
   * Skips rather than throws on the two cases a bulk move always hits: a stop
   * already on the target, and a quota that is already served that day by
   * someone (moving would collide with its own other stop). Reported, not
   * silent — a bulk edit that quietly dropped members would be worse than one
   * that refused outright.
   */
  reassign(selection: RegionSelection, techId: string, weekday: Weekday): ReassignReport {
    const moved: SelectedStop[] = []
    const placed: string[] = []
    const skipped: { quotaId: string; reason: string }[] = []

    // Owed quotas first: placing one is a new stop, not a move — it comes off
    // the owed list and onto the change list in the same breath.
    for (const quotaId of selection.owed) {
      const quota = this.quotas.get(quotaId)
      if (!quota) {
        skipped.push({ quotaId, reason: "not in this scenario" })
        continue
      }
      const why = quota.refusal(techId, weekday)
      if (why) {
        skipped.push({ quotaId, reason: why })
        continue
      }
      this.edit(quotaId, (q) => q.place(techId, weekday))
      placed.push(quotaId)
    }

    for (const sel of selection.stops) {
      const quota = this.quotas.get(sel.quotaId)
      if (!quota) {
        skipped.push({ quotaId: sel.quotaId, reason: "not in this scenario" })
        continue
      }
      if (sel.techId === techId && sel.weekday === weekday) {
        skipped.push({ quotaId: sel.quotaId, reason: "already there" })
        continue
      }
      const why = quota.refusal(techId, weekday, { techId: sel.techId, weekday: sel.weekday })
      if (why) {
        skipped.push({ quotaId: sel.quotaId, reason: why })
        continue
      }
      this.edit(sel.quotaId, (q) =>
        q.move({ techId: sel.techId, weekday: sel.weekday }, { techId, weekday }),
      )
      moved.push(sel)
    }
    return { moved, placed, skipped }
  }

  /**
   * Hand a whole route to another tech: every stop on (techId, weekday) moves
   * to (toTechId, weekday). Same pins, same day — when the receiving tech has
   * no route that day this costs nothing, which is exactly why it is the cheap
   * lever for rebalancing headcount.
   */
  reassignRouteTech(techId: string, weekday: Weekday, toTechId: string): ReassignReport {
    const stops: SelectedStop[] = []
    for (const quota of this.quotas.values()) {
      for (const s of quota.stops) {
        if (s.techId === techId && s.weekday === weekday)
          stops.push({ quotaId: quota.id, techId, weekday })
      }
    }
    return this.reassign({ stops, owed: [] }, toTechId, weekday)
  }

  private edit(quotaId: string, change: (q: Quota) => unknown): void {
    const quota = this.quotas.get(quotaId)
    if (!quota) throw new Error(`no quota ${quotaId} in this scenario`)
    change(quota)
    for (const e of quota.pullEvents()) this.record(e)
  }

  /**
   * Record one event, keeping the change list the MINIMAL honest diff against
   * live. Every recorded event is pending by definition, so pairs that cancel
   * or combine do so here rather than crowding the list:
   *   Removed(a) … Placed(b)      → Moved(a→b), or nothing when b = a
   *   Placed(b) … Removed(b)      → nothing (placed, then changed our mind)
   *   Moved(a→b) … Removed(b)     → Removed(a)
   * An owed pool mid-rebuild still carries its StopRemoved until it lands.
   */
  private record(e: RoutingEvent): void {
    const same = (x: Placement, y: Placement) => x.techId === y.techId && x.weekday === y.weekday
    if (e.kind === "StopPlaced") {
      for (let i = this.recorded.length - 1; i >= 0; i--) {
        const prior = this.recorded[i]
        if (prior.kind === "StopRemoved" && prior.quotaId === e.quotaId) {
          this.recorded.splice(i, 1)
          if (!same(prior.from, e.to)) {
            this.recorded.push({ kind: "StopMoved", quotaId: e.quotaId, from: prior.from, to: e.to })
          }
          return
        }
      }
    }
    if (e.kind === "StopRemoved") {
      for (let i = this.recorded.length - 1; i >= 0; i--) {
        const prior = this.recorded[i]
        if (prior.quotaId !== e.quotaId) continue
        if (prior.kind === "StopPlaced" && same(prior.to, e.from)) {
          this.recorded.splice(i, 1)
          return
        }
        if (prior.kind === "StopMoved" && same(prior.to, e.from)) {
          this.recorded.splice(i, 1)
          this.recorded.push({ kind: "StopRemoved", quotaId: e.quotaId, from: prior.from, reason: e.reason })
          return
        }
      }
    }
    this.recorded.push(e)
  }

  /* ---------------------------------------------------------------- reads */

  get all(): readonly Quota[] {
    return [...this.quotas.values()]
  }

  stopsOf(quotaId: string): readonly Stop[] {
    return this.quotas.get(quotaId)?.stops ?? []
  }

  /**
   * The unplaced layer: quotas still owed placements. On a map these render
   * as their Pins — requirement-side data, drawable whether or not any stop
   * exists (a quota missing N placements is one pin with an xN badge: the
   * missing placements are fungible, so they are a count, never objects).
   * No placeholder stops, ever (I1).
   */
  unplacedQuotas(): readonly Quota[] {
    return [...this.quotas.values()].filter((q) => q.unmetCount() > 0)
  }

  /**
   * The unplaced layer, partitioned the way practice thinks about it:
   * DISPLACED — this scenario took placements away, and the events remember
   * exactly which (tech, day) each came from — versus BACKLOG — needed
   * placing before we touched anything. This is ION's "admin tech" as a
   * query: the disturbed batch keeps its memory and its grouping without a
   * sentinel tech or a second kind of stop.
   */
  unplacedLayer(): {
    displaced: ReadonlyArray<{ quota: Quota; from: readonly Placement[] }>
    backlog: readonly Quota[]
  } {
    const removedFrom = new Map<string, Placement[]>()
    for (const e of this.recorded) {
      const take = (quotaId: string, p: Placement) => {
        const bucket = removedFrom.get(quotaId)
        if (bucket) bucket.push(p)
        else removedFrom.set(quotaId, [p])
      }
      if (e.kind === "StopRemoved") take(e.quotaId, e.from)
      if (e.kind === "StopPlaced" || e.kind === "StopMoved") {
        // A later placement consumes one owed re-home.
        removedFrom.get(e.quotaId)?.shift()
      }
    }
    const displaced: Array<{ quota: Quota; from: readonly Placement[] }> = []
    const backlog: Quota[] = []
    for (const quota of this.unplacedQuotas()) {
      const from = removedFrom.get(quota.id)
      if (from && from.length > 0) displaced.push({ quota, from })
      else backlog.push(quota)
    }
    return { displaced, backlog }
  }

  /** The proposed routes as they now stand — re-derived, nothing stale. */
  routes(factory: RouteFactory, week: WeekIndex): Route[] {
    return factory.territory(this.all, week)
  }

  routeFor(factory: RouteFactory, techId: string, weekday: Weekday, week: WeekIndex): Route | null {
    return factory.routeFor(this.all, techId, weekday, week)
  }

  /**
   * How many edits this scenario has recorded. A reader that keys its derived
   * values on this cannot show a stale view: the number changes exactly when
   * the scenario does, so nobody has to remember to signal it.
   */
  get revision(): number {
    return this.recorded.length
  }

  /** A snapshot of the proposed changes, in the order they were made. */
  changes(): readonly RoutingEvent[] {
    return [...this.recorded]
  }

  /** The (tech, weekday) pairs any change touched — the routes worth re-reading. */
  affectedRoutes(): ReadonlyArray<{ techId: string; weekday: Weekday }> {
    const keys = new Map<string, { techId: string; weekday: Weekday }>()
    for (const e of this.recorded) {
      const touch = (p: { techId: string; weekday: Weekday }) => keys.set(`${p.techId}|${p.weekday}`, p)
      if (e.kind === "StopPlaced") touch(e.to)
      if (e.kind === "StopRemoved") touch(e.from)
      if (e.kind === "StopMoved") {
        touch(e.from)
        touch(e.to)
      }
      if (e.kind === "AnchorShifted") {
        // A phase change reshapes every run this quota rides.
        for (const stop of this.quotas.get(e.quotaId)?.stops ?? []) touch(stop)
      }
    }
    return [...keys.values()]
  }

  /**
   * Adopt: publish this scenario's changes toward permanence. The publisher
   * arrives as an argument (double dispatch) — the scenario holds no
   * infrastructure, it is handed a port for one operation. The gate is not
   * checked here; it is structural: Adoption.of refuses to exist for a
   * blocked or empty scenario. dryRun defaults to true — a real write is
   * always an explicit second step.
   */
  async adopt(
    publisher: RoutePublisher,
    scenarioId: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<PublishResult[]> {
    const adoption = Adoption.of(this, scenarioId)
    return publisher.publish(adoption.changes, { dryRun: opts.dryRun ?? true })
  }

  /**
   * The adoption gate: every quota an edit touched must still be covered and
   * spaced. Blockers, not warnings — a scenario that breaks a quota's own
   * rules cannot become the live plan.
   */
  adoptionBlockers(): AdoptionBlocker[] {
    const touched = new Set(this.recorded.map((e) => e.quotaId))
    const blockers: AdoptionBlocker[] = []
    for (const quotaId of touched) {
      const quota = this.quotas.get(quotaId)
      if (!quota) continue
      const coverage = quota.coverage()
      if (!coverage.met) {
        blockers.push({
          quotaId,
          rule: "coverage",
          detail: `${coverage.placed}/${coverage.required} stops`,
        })
      }
      const spacing = quota.spacing()
      if (!spacing.met) {
        blockers.push({
          quotaId,
          rule: "spacing",
          detail: `gaps [${spacing.gapsDays.join(",")}]d, minimum ${spacing.minimumDays}d`,
        })
      }
    }
    return blockers
  }
}
