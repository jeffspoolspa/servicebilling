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
