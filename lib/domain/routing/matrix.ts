/**
 * The drive matrix — the one place a leg between two quotas is measured.
 *
 * Every distance the domain uses routes through here: ordering, estimates,
 * stop legs, move pricing. Today a leg is haversine straight-line; when real
 * road times arrive (OSRM /table), they land HERE and nothing above notices —
 * that seam is the point of making the matrix first-class.
 *
 * Warm-started from the territory (485 pins ≈ 117k pairs, milliseconds) and
 * memoizing on miss, so a quota created later — a prospect dropped into a
 * scenario — joins the matrix the first time anything measures against it.
 * Loaded once per page and shared, scenario edits become pure lookups.
 */

import { Leg, Pin } from "./values"
import type { Quota } from "./quota"

/**
 * A measured real-road leg, direction-specific: A→B is not B→A (one-ways,
 * medians, left turns). Learned from a routing engine, never estimated.
 */
export interface MeasuredLeg {
  readonly fromId: string
  readonly toId: string
  readonly minutes: number
  readonly miles: number
}

/** A base's identity in the matrix — derived from the pin, stable across pages. */
export function baseIdOf(pin: Pin): string {
  return `base:${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}`
}

export class DriveMatrix {
  /** Straight-line miles, unrounded, keyed on the sorted id pair (symmetric today). */
  private readonly miles = new Map<string, number>()
  private readonly pins = new Map<string, Pin>()
  /** Real road minutes and miles, keyed DIRECTED ("a>b") — asymmetric by nature. */
  private readonly realMinutes = new Map<string, number>()
  private readonly realMiles = new Map<string, number>()

  /** Precompute every pair for a set of quotas. */
  static of(quotas: readonly Quota[]): DriveMatrix {
    const matrix = new DriveMatrix()
    for (const q of quotas) matrix.add(q)
    return matrix
  }

  /**
   * Admit one quota: register its pin and measure it against every quota
   * already here. Part of a quota's creation, per the model — a quota the
   * matrix has never met cannot be routed against.
   */
  add(quota: Quota): void {
    const pin = quota.requirement.pin
    if (!pin) return
    if (this.pins.has(quota.id)) return
    for (const [otherId, otherPin] of this.pins) {
      this.miles.set(keyOf(quota.id, otherId), pin.distanceTo(otherPin))
    }
    this.pins.set(quota.id, pin)
  }

  /**
   * Miles between two quotas. Falls back to the pins handed in when either
   * side is unknown — and memoizes the answer, so the unknown side has just
   * been added for every measurement after this one.
   *
   * A memo keyed by id is only as honest as the pins behind it: if a quota
   * shows up with a different pin than the one it was measured at (an address
   * correction), every leg touching it is stale — so its row is purged and
   * re-measured lazily rather than served wrong.
   */
  milesBetween(aId: string, bId: string, aPin: Pin, bPin: Pin): number {
    if (aId === bId) return 0
    this.heal(aId, aPin)
    this.heal(bId, bPin)
    const key = keyOf(aId, bId)
    const known = this.miles.get(key)
    if (known !== undefined) return known
    const measured = aPin.distanceTo(bPin)
    this.miles.set(key, measured)
    if (!this.pins.has(aId)) this.pins.set(aId, aPin)
    if (!this.pins.has(bId)) this.pins.set(bId, bPin)
    return measured
  }

  /** If this id moved, forget every leg it appears in. Rare, so a scan is fine. */
  private heal(id: string, pin: Pin): void {
    const stored = this.pins.get(id)
    if (!stored || stored.equals(pin)) return
    for (const key of [...this.miles.keys()]) {
      const at = key.indexOf("|")
      if (key.slice(0, at) === id || key.slice(at + 1) === id) this.miles.delete(key)
    }
    this.pins.set(id, pin)
  }

  /** The leg as a value object: the pair, its miles, and the estimated drive minutes. */
  legBetween(aId: string, bId: string, aPin: Pin, bPin: Pin, detourFactor: number, averageMph: number): Leg {
    const straight = this.milesBetween(aId, bId, aPin, bPin)
    return Leg.of(aId, bId, straight * detourFactor, ((straight * detourFactor) / averageMph) * 60)
  }

  /**
   * Take on measured road legs. Real times REPLACE the estimate wherever they
   * exist and win every later lookup — the estimate never overwrites a
   * measurement, and everything above notices nothing but better numbers.
   */
  learn(legs: readonly MeasuredLeg[]): void {
    for (const leg of legs) {
      const key = `${leg.fromId}>${leg.toId}`
      this.realMinutes.set(key, leg.minutes)
      this.realMiles.set(key, leg.miles)
    }
  }

  /** Measured minutes for the directed pair, or null when never measured. */
  realMinutesBetween(fromId: string, toId: string): number | null {
    return this.realMinutes.get(`${fromId}>${toId}`) ?? null
  }

  realMilesBetween(fromId: string, toId: string): number | null {
    return this.realMiles.get(`${fromId}>${toId}`) ?? null
  }

  /** Has every directed hop in this ordered ring been measured? */
  hasMeasured(orderedIds: readonly string[]): boolean {
    for (let i = 0; i < orderedIds.length - 1; i++) {
      if (!this.realMinutes.has(`${orderedIds[i]}>${orderedIds[i + 1]}`)) return false
    }
    return orderedIds.length > 1
  }

  get size(): number {
    return this.miles.size
  }

  get measuredSize(): number {
    return this.realMinutes.size
  }
}

const keyOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
