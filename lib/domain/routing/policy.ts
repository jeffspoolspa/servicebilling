/**
 * Every named threshold, in one place.
 *
 * These are policy, not geography (Territory is the drive area from an office).
 * Nothing else in the domain may hard-code a number that belongs here.
 */

export const ROUTING_POLICY = {
  /** A trusted stop further than this from its route's centre is suspect. */
  farFromRouteMi: 25,
  /** Below this many pinned mates, a route has no meaningful centre. */
  minRouteMates: 3,
  /** Beyond this from any office, an address is out of range. */
  officeRangeMi: 50,

  /** Coordinates outside this box are not in the service area. */
  serviceBounds: { minLat: 30.2, maxLat: 32.7, minLng: -82.4, maxLng: -80.6 },

  drive: {
    /** Straight-line miles are multiplied by this to approximate road miles. */
    detourFactor: 1.3,
    averageMph: 32,
    minutesPerStop: 22,
    /**
     * Fixed per-stop overhead — park, gear out of the truck, gate, log the
     * visit, gear back in. On top of on-site service minutes everywhere a
     * stop is priced, so the hours limit binds naturally.
     */
    stopOverheadMinutes: 10,
    workdayMinutes: 480,
  },

  /**
   * Minimum days between a quota's services, by how many it needs per week.
   * Roughly half the ideal gap, so ordinary variation passes and clumping fails.
   */
  minGapDays: { 1: 0, 2: 3, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1 } as Record<number, number>,

  /** A route carrying more stops than this is worth a look. Advisory only. */
  routeSizeWarning: 18,

  /**
   * Move resistance, in minutes, per kind of disruption — what a customer's
   * plan-change costs beyond the road. All zero for now, deliberately: the
   * kinds are LOGGED on every priced move because day and tech changes have
   * downstream effects (customer notice, gate codes, expectations), but the
   * prices are elicitation — tiers filled in with the office, then learnable
   * from vetoes — not something to invent here.
   */
  /**
   * The planner's slot-packing target: it closes a slot when the estimated day
   * reaches this share of the workday, leaving headroom for reality (a long
   * pool, traffic, a callback). 1.0 would pack days flush against the ceiling.
   */
  plannerTargetUtilization: 0.9,

  /**
   * The optimizing cap: neither engine builds or grows a route past this many
   * pools. A rule for PROPOSALS, not a live-plan invariant — existing bigger
   * routes stand, but no suggestion or draft makes one bigger.
   */
  maxPoolsPerRoute: 10,

  /**
   * Continuity — every cadence period gets exactly the contracted number of
   * visits across a schedule edit: none doubled, none skipped.
   *
   * ADVISORY for now, like moveResistance below: the calculation runs and
   * reports from day one, but does not block adoption until it has been
   * watched against real scenarios. Flip blocksAdoption to make it binding —
   * that is the only change needed, because the gate reads this and the
   * calculation does not decide its own severity.
   */
  continuity: {
    blocksAdoption: false,
    /** Extra visits tolerated in a period. 0 = a double visit is a violation. */
    extraVisitsAllowed: 0,
  },

  moveResistance: {
    place: 0,
    unplace: 0,
    tech: 0,
    day: 0,
    tech_day: 0,
    anchor: 0,
  },
} as const

export type RoutingPolicy = typeof ROUTING_POLICY
