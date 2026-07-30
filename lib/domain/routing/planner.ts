/**
 * The planner — construction, blind to the incumbent.
 *
 * The Optimizer walks downhill from today's plan; it can only reach what a
 * chain of individually-paying moves can reach. The Planner never stands in
 * today's plan at all: it rebuilds from geography, cadence, and capacity, so
 * clusters the incumbent has scattered land together naturally. Its output is
 * a draft world of TECH-AGNOSTIC slots — deliberately unassigned, because
 * which human drives a slot is a later, cheaper decision (and for a fresh
 * plan, an open staffing question).
 *
 * A plan is never deployed directly. It is a benchmark (how much headroom
 * exists) and a diff source: `diff(live, world)` turns it into ordinary
 * RoutingEvents — a Scenario — inspected, priced, and walked toward like any
 * other proposal.
 *
 * Algorithm (classic cluster-first decomposition, one pass each):
 *   1. base assignment — every pinned quota anchors to its nearest office
 *   2. day patterns — each quota gets a cadence-legal set of weekdays
 *      (min-gap rules from policy), chosen to balance daily load while
 *      following its nearest already-placed neighbour (streets stay together)
 *   3. slot packing — per (office, day), stops in sweep order (polar angle
 *      around the base) fill a slot until the estimated day reaches the
 *      packing target; then a new slot opens
 *
 * All pricing goes through the same geometry/estimate as everything else —
 * one truth about cost, two searchers over it.
 */

import type { Placement, RoutingEvent } from "./events"
import { RouteGeometry, type Placeable } from "./geometry"
import { ROUTING_POLICY, type RoutingPolicy } from "./policy"
import { Quota } from "./quota"
import { Scenario } from "./scenario"
import { Pin, type Weekday } from "./values"

export interface PlanBase {
  readonly label: string
  readonly pin: Pin
}

export interface PlannedSlot {
  /** Pseudo tech id: `plan:<office>:<weekday>:<n>` — a slot, not a person. */
  readonly slotId: string
  readonly office: string
  readonly weekday: Weekday
  readonly quotaIds: readonly string[]
}

export interface PlannedWorld {
  readonly slots: readonly PlannedSlot[]
  /** Every slot's base pin, so the ordinary factory can price the draft. */
  readonly slotBases: ReadonlyMap<string, Pin>
  readonly slotLabels: Readonly<Record<string, string>>
  /** quotaId → its planned placements. */
  readonly placements: ReadonlyMap<string, readonly Placement[]>
  /** Quotas the planner could not seat (no pin, or no legal day pattern). */
  readonly unplanned: readonly string[]
}

/** A natural geographic cluster: pools chained within the given radius. */
export interface QuotaCluster {
  readonly quotaIds: readonly string[]
  readonly centre: Pin
}

export interface ClusterView {
  readonly clusters: readonly QuotaCluster[]
  /** Pools with no neighbour inside the radius — they belong to no cluster. */
  readonly loners: readonly string[]
}

export class Planner {
  constructor(
    private readonly geometry: RouteGeometry = new RouteGeometry(),
    private readonly policy: RoutingPolicy = ROUTING_POLICY,
  ) {}

  /**
   * Draft a fresh world for these quotas over the given offices and weekdays.
   * Uses as few slots as fit under the packing target — route count is an
   * output, not an input.
   */
  plan(
    quotas: readonly Quota[],
    bases: readonly PlanBase[],
    days: readonly Weekday[],
    opts: { maxSlotsPerDay?: number } = {},
  ): PlannedWorld {
    const placements = new Map<string, Placement[]>()
    const unplanned: string[] = []
    const usable = bases.filter((b) => b.pin)
    if (usable.length === 0 || days.length === 0)
      return { slots: [], slotBases: new Map(), slotLabels: {}, placements, unplanned: quotas.map((q) => q.id) }

    // 1 — nearest office anchors each pinned quota.
    const byOffice = new Map<string, Quota[]>()
    for (const q of quotas) {
      const pin = q.requirement.pin
      if (!pin) {
        unplanned.push(q.id)
        continue
      }
      const nearest = usable.reduce((best, b) =>
        pin.distanceTo(b.pin) < pin.distanceTo(best.pin) ? b : best,
      )
      const bucket = byOffice.get(nearest.label)
      if (bucket) bucket.push(q)
      else byOffice.set(nearest.label, [q])
    }

    const slots: PlannedSlot[] = []
    const slotBases = new Map<string, Pin>()
    const slotLabels: Record<string, string> = {}

    for (const [office, group] of byOffice) {
      const base = usable.find((b) => b.label === office)!.pin

      // Sweep order: polar angle around the base — geographic neighbours are
      // list neighbours, which is what keeps streets together downstream.
      const sweep = [...group].sort((a, b) => angleAround(base, a) - angleAround(base, b))

      // 2 — day patterns. Cohesion first: a quota follows its sweep neighbour's
      // day unless that day is FULL — balance is a capacity constraint (the
      // slot inventory), never a preference that splits a street. Day capacity
      // = slots that day × the packing target; the default inventory is the
      // fewest slots per day that could hold this office's total work.
      const target = this.policy.plannerTargetUtilization * this.policy.drive.workdayMinutes
      const totalMinutes = group.reduce(
        (n, q) => n + (q.requirement.serviceMinutes ?? this.policy.drive.minutesPerStop) * q.requirement.requiredDays,
        0,
      )
      const slotsPerDay =
        opts.maxSlotsPerDay ?? Math.max(1, Math.ceil(totalMinutes / target / days.length))
      const dayCap = slotsPerDay * target
      const dayLoad = new Map<Weekday, number>(days.map((d) => [d, 0]))
      const dayOf = new Map<string, Weekday[]>() // quotaId → its days
      let prev: Quota | null = null
      for (const q of sweep) {
        const legal = patternsFor(q.requirement.requiredDays, days, this.policy)
        if (legal.length === 0) {
          unplanned.push(q.id)
          continue
        }
        const minutes = q.requirement.serviceMinutes ?? this.policy.drive.minutesPerStop
        const prevDays = prev ? new Set(dayOf.get(prev.id) ?? []) : new Set<Weekday>()
        const fits = (p: readonly Weekday[]) => p.every((d) => (dayLoad.get(d) ?? 0) + minutes <= dayCap)
        const load = (p: readonly Weekday[]) =>
          p.reduce((n: number, d) => n + (dayLoad.get(d) ?? 0), 0) / p.length
        const affinity = (p: readonly Weekday[]) => p.filter((d) => prevDays.has(d)).length
        const feasible = legal.filter(fits)
        const pool = feasible.length > 0 ? feasible : legal // overflow beats unplanned
        const best = [...pool].sort((a, b) => affinity(b) - affinity(a) || load(a) - load(b))[0]
        for (const d of best) dayLoad.set(d, (dayLoad.get(d) ?? 0) + minutes)
        dayOf.set(q.id, [...best])
        prev = q
      }

      // 3 — pack each day's sweep into slots under the target.
      for (const day of days) {
        const todays = sweep.filter((q) => dayOf.get(q.id)?.includes(day))
        if (todays.length === 0) continue
        let members: Quota[] = []
        let index = 1
        const close = () => {
          if (members.length === 0) return
          const slotId = `plan:${office}:${day}:${index}`
          slots.push({ slotId, office, weekday: day, quotaIds: members.map((m) => m.id) })
          slotBases.set(slotId, base)
          slotLabels[slotId] = `${office} route ${index}`
          for (const m of members) {
            const list = placements.get(m.id) ?? []
            list.push({ techId: slotId, weekday: day })
            placements.set(m.id, list)
          }
          index++
          members = []
        }
        for (const q of todays) {
          const trial = [...members, q]
          const est = this.geometry.estimate(trial.map(placeableOf), base)
          // A slot closes on time OR on the pool cap. Open a new one only
          // while the inventory allows; the last slot absorbs overflow — an
          // over-full day is a visible fact, a phantom route is a lie.
          const full =
            (est.minutes > target || members.length >= this.policy.maxPoolsPerRoute) &&
            members.length > 0
          if (full && index < slotsPerDay) close()
          members.push(q)
        }
        close()
      }
    }

    return { slots, slotBases, slotLabels, placements, unplanned }
  }

  /** The draft as live aggregates, so every existing read model prices it. */
  toScenario(quotas: readonly Quota[], world: PlannedWorld): Scenario {
    return Scenario.from(
      quotas.map((q) => {
        const planned = world.placements.get(q.id)
        if (!planned) return Quota.rehydrate(q.requirement, q.stops)
        return Quota.rehydrate(
          q.requirement,
          planned.map((p) => ({ techId: p.techId, weekday: p.weekday })),
        )
      }),
    )
  }

  /**
   * Natural clustering, no incumbent, no days: chain pools whose pins sit
   * within `epsilonMi` of a member (single-link union). The lens for "these
   * belong together as we route" — and its complement, the pools that belong
   * to nothing, which are the true cost drivers (every one is a detour
   * somebody pays weekly).
   */
  clustersOf(quotas: readonly Quota[], epsilonMi = 0.5): ClusterView {
    const pinned = quotas.filter((q) => q.requirement.pin !== null)
    const parent = new Map<string, string>()
    const find = (id: string): string => {
      let root = id
      while (parent.get(root) !== root) root = parent.get(root)!
      parent.set(id, root)
      return root
    }
    for (const q of pinned) parent.set(q.id, q.id)
    for (let i = 0; i < pinned.length; i++) {
      for (let j = i + 1; j < pinned.length; j++) {
        if (pinned[i].requirement.pin!.distanceTo(pinned[j].requirement.pin!) <= epsilonMi) {
          parent.set(find(pinned[i].id), find(pinned[j].id))
        }
      }
    }
    const groups = new Map<string, Quota[]>()
    for (const q of pinned) {
      const root = find(q.id)
      const g = groups.get(root) ?? []
      g.push(q)
      groups.set(root, g)
    }
    const clusters: QuotaCluster[] = []
    const loners: string[] = []
    for (const members of groups.values()) {
      // Two quotas of one customer at one property are not a cluster — a
      // cluster is at least two DISTINCT customers near each other.
      const customers = new Set(members.map((m) => m.requirement.customerId ?? m.id))
      if (members.length < 2 || customers.size < 2) {
        for (const m of members) loners.push(m.id)
        continue
      }
      const lat = members.reduce((n, q) => n + q.requirement.pin!.lat, 0) / members.length
      const lng = members.reduce((n, q) => n + q.requirement.pin!.lng, 0) / members.length
      clusters.push({ quotaIds: members.map((m) => m.id), centre: Pin.hypothetical(lat, lng) })
    }
    clusters.sort((a, b) => b.quotaIds.length - a.quotaIds.length)
    return { clusters, loners }
  }

  /**
   * Hand slots to real techs by maximum overlap: each slot goes to whichever
   * tech already serves the most of its stops on that weekday — the fewest
   * customers see a new face, which is the free part of disruption to save.
   * Slots nobody overlaps keep their pseudo id: a route that needs a tech is
   * a staffing signal, not a coin flip.
   */
  assign(live: readonly Quota[], world: PlannedWorld): Map<string, string> {
    // tech → the quotas they serve per weekday, from the incumbent.
    const serves = new Map<string, Set<string>>() // `${techId}|${weekday}` → quotaIds
    for (const q of live) {
      for (const st of q.stops) {
        const key = `${st.techId}|${st.weekday}`
        const set = serves.get(key) ?? new Set()
        set.add(q.id)
        serves.set(key, set)
      }
    }
    const assignment = new Map<string, string>()
    const taken = new Set<string>() // `${techId}|${weekday}` — one slot per tech-day
    const pairs: { slotId: string; techKey: string; techId: string; overlap: number }[] = []
    for (const slot of world.slots) {
      for (const [techKey, quotaIds] of serves) {
        const [techId, d] = techKey.split("|")
        if (Number(d) !== slot.weekday) continue
        const overlap = slot.quotaIds.filter((id) => quotaIds.has(id)).length
        if (overlap > 0) pairs.push({ slotId: slot.slotId, techKey, techId, overlap })
      }
    }
    pairs.sort((a, b) => b.overlap - a.overlap)
    for (const p of pairs) {
      if (assignment.has(p.slotId) || taken.has(p.techKey)) continue
      assignment.set(p.slotId, p.techId)
      taken.add(p.techKey)
    }
    for (const slot of world.slots) {
      if (!assignment.has(slot.slotId)) assignment.set(slot.slotId, slot.slotId)
    }
    return assignment
  }

  /**
   * The path from today to the draft, as ordinary events. Same-day pairings
   * come out as tech-only moves (the cheap kind); the rest as day moves;
   * missing placements as places. Slot ids ride in the `to` — tech-agnostic
   * until a human assigns slots to people.
   */
  diff(
    live: readonly Quota[],
    world: PlannedWorld,
    assignment?: ReadonlyMap<string, string>,
  ): RoutingEvent[] {
    const out: RoutingEvent[] = []
    const resolve = (p: Placement): Placement =>
      assignment ? { techId: assignment.get(p.techId) ?? p.techId, weekday: p.weekday } : p
    for (const q of live) {
      const planned = world.placements.get(q.id)
      if (!planned) continue
      const current = [...q.stops]
      const wanted = planned.map(resolve)

      // Pair same-weekday first — those are tech-only changes or no-ops.
      for (let i = wanted.length - 1; i >= 0; i--) {
        const at = current.findIndex((s) => s.weekday === wanted[i].weekday)
        if (at < 0) continue
        const cur = current.splice(at, 1)[0]
        const want = wanted.splice(i, 1)[0]
        if (cur.techId !== want.techId) {
          out.push({ kind: "StopMoved", quotaId: q.id, from: { techId: cur.techId, weekday: cur.weekday }, to: want })
        }
      }
      // Remaining pairs are day moves; leftovers place or stay owed.
      while (wanted.length > 0 && current.length > 0) {
        const cur = current.shift()!
        const want = wanted.shift()!
        out.push({ kind: "StopMoved", quotaId: q.id, from: { techId: cur.techId, weekday: cur.weekday }, to: want })
      }
      for (const want of wanted) out.push({ kind: "StopPlaced", quotaId: q.id, to: want })
    }
    return out
  }
}

const placeableOf = (q: Quota): Placeable => ({
  pin: q.requirement.pin,
  orderingConstraint: q.requirement.orderingConstraint,
  serviceMinutes: q.requirement.serviceMinutes,
  quotaId: q.id,
})

function angleAround(base: Pin, q: Quota): number {
  const pin = q.requirement.pin!
  return Math.atan2(pin.lat - base.lat, pin.lng - base.lng)
}

/** All cadence-legal weekday sets of size k, by the same min-gap rule spacing checks. */
function patternsFor(k: number, days: readonly Weekday[], policy: RoutingPolicy): Weekday[][] {
  const minGap = policy.minGapDays[Math.min(k, 7) as keyof typeof policy.minGapDays] ?? 0
  if (k <= 1) return days.map((d) => [d])
  const combos: Weekday[][] = []
  const pick = (start: number, acc: Weekday[]) => {
    if (acc.length === k) {
      combos.push([...acc])
      return
    }
    for (let i = start; i < days.length; i++) pick(i + 1, [...acc, days[i]])
  }
  pick(0, [])
  return combos.filter((combo) => {
    const sorted = [...combo].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[(i + 1) % sorted.length]
      const gap = i === sorted.length - 1 ? next + 7 - sorted[i] : next - sorted[i]
      if (gap < minGap) return false
    }
    return true
  })
}
