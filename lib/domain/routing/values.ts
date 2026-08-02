/**
 * The value objects. Immutable, compared by value, no identity.
 *
 * Classes appear here only where construction must be guarded (Pin); the rest
 * are plain readonly types with functions, because they have nothing to guard
 * and must serialise untouched.
 */

import { ROUTING_POLICY } from "./policy"

/* ---------------------------------------------------------------- weekday */

/** 0 = Sunday, matching Postgres `extract(dow)`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export function isWeekday(n: number): n is Weekday {
  return Number.isInteger(n) && n >= 0 && n <= 6
}

/* -------------------------------------------------------------- week index */

/**
 * A sequential number for every week from a fixed epoch.
 *
 * The epoch is Monday 5 January 1970 — the same one buried in the ION parser's
 * parity maths, hoisted here so one definition serves everything.
 */
export type WeekIndex = number

const EPOCH_MS = Date.UTC(1970, 0, 5)
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

export function weekOf(date: Date): WeekIndex {
  return Math.floor((date.getTime() - EPOCH_MS) / MS_PER_WEEK)
}

/** Midnight UTC on the Monday that opens this week. */
export function weekStart(week: WeekIndex): Date {
  return new Date(EPOCH_MS + week * MS_PER_WEEK)
}

/**
 * A single day, as one number: the week times seven plus the weekday.
 * Subtracting two of these gives the gap in days, which is what spacing needs.
 */
export function dayIndex(week: WeekIndex, weekday: Weekday): number {
  return week * 7 + ((weekday + 6) % 7) // shift so Monday opens the week
}

/* ------------------------------------------------------------------ window */

/** A span of weeks to project over. */
export interface Window {
  readonly fromWeek: WeekIndex
  readonly weekCount: number
}

export function windowOf(fromWeek: WeekIndex, weekCount: number): Window {
  if (weekCount < 1) throw new RangeError("a window covers at least one week")
  return { fromWeek, weekCount }
}

export function weeksIn(w: Window): WeekIndex[] {
  return Array.from({ length: w.weekCount }, (_, i) => w.fromWeek + i)
}

export function windowContains(w: Window, week: WeekIndex): boolean {
  return week >= w.fromWeek && week < w.fromWeek + w.weekCount
}

/* ----------------------------------------------------------------- cadence */

/** How often a quota must be met, and which of the alternating weeks it takes. */
export type CadenceInterval = 1 | 2 | 4

export interface Cadence {
  readonly intervalWeeks: CadenceInterval
  /** Any week the quota fires; only its remainder mod the interval matters. */
  readonly anchorWeek: WeekIndex
}

export function cadence(intervalWeeks: CadenceInterval, anchorWeek: WeekIndex): Cadence {
  return { intervalWeeks, anchorWeek }
}

export function firesOn(c: Cadence, week: WeekIndex): boolean {
  const offset = (week - c.anchorWeek) % c.intervalWeeks
  return (offset + c.intervalWeeks) % c.intervalWeeks === 0
}

/** The most recent week on or before this one in which the cadence fires. */
export function lastFiringOnOrBefore(c: Cadence, week: WeekIndex): WeekIndex {
  const offset = (((week - c.anchorWeek) % c.intervalWeeks) + c.intervalWeeks) % c.intervalWeeks
  return week - offset
}

/** The first week on or after this one in which the cadence fires. */
export function nextFiringOnOrAfter(c: Cadence, week: WeekIndex): WeekIndex {
  const offset = (((week - c.anchorWeek) % c.intervalWeeks) + c.intervalWeeks) % c.intervalWeeks
  return offset === 0 ? week : week + (c.intervalWeeks - offset)
}

/** A future service: which week it lands in, and on which day. */
export interface Occurrence {
  readonly week: WeekIndex
  readonly weekday: Weekday
}

/**
 * When a stop on this weekday will NEXT be served — the system of record's
 * generator, modelled.
 *
 * ION schedules any serviced day that has not passed yet in a week the cadence
 * fires. That single behaviour is why a mid-week edit can double a visit: move
 * Tuesday to Thursday on a Wednesday and Tuesday is already served while
 * Thursday is still ahead, so both happen. Make the same move on a Friday and
 * Thursday has passed, so the next one falls in the following cycle.
 *
 * Same-day counts as PASSED. Whether ION has already generated today's visit
 * depends on when its job ran, so treating today as still-available would be a
 * race; the safe reading is that today is spoken for.
 */
/**
 * Where a weekday sits inside a MONDAY-start week: Mon 0 .. Sun 6.
 *
 * Weekday NUMBERS are ION's (day1..day7 = Sun..Sat, so 0 = Sun) but weeks RUN
 * Monday to Sunday — see weekStart. Those are two different things and mixing
 * them makes Sunday look like the first day of the week instead of the last,
 * which silently inverts every "has this day passed yet" question.
 */
export function positionInWeek(weekday: number): number {
  return (weekday + 6) % 7
}

export function nextOccurrence(
  c: Cadence,
  weekday: Weekday,
  fromWeek: WeekIndex,
  fromWeekday: number,
): Occurrence {
  const passed = positionInWeek(weekday) <= positionInWeek(fromWeekday)
  if (firesOn(c, fromWeek) && !passed) return { week: fromWeek, weekday }
  return { week: nextFiringOnOrAfter(c, fromWeek + 1), weekday }
}

export function cadenceLabel(c: Cadence): string {
  if (c.intervalWeeks === 1) return "weekly"
  if (c.intervalWeeks === 4) return "monthly"
  return c.anchorWeek % 2 === 0 ? "biweekly A" : "biweekly B"
}

/* ------------------------------------------------------- ordering constraint */

/** Knowledge geometry cannot derive: this pool must be first, or last. */
export type OrderingConstraint = "none" | "first" | "last"

/* --------------------------------------------------------------------- pin */

export interface Geocode {
  readonly lat: number
  readonly lng: number
  readonly status: string | null
  readonly placeId: string | null
}

/**
 * A trusted coordinate. The private constructor is the point: only a
 * rooftop-confirmed geocode inside the service area becomes a Pin, so nothing
 * downstream has to re-check whether a coordinate can be believed.
 */
export class Pin {
  private constructor(
    readonly lat: number,
    readonly lng: number,
  ) {}

  static fromTrusted(g: Geocode | null | undefined): Pin | null {
    if (!g || g.status !== "ok" || !g.placeId) return null
    if (!Pin.inServiceArea(g.lat, g.lng)) return null
    return new Pin(g.lat, g.lng)
  }

  /** Escape hatch for hypothetical quotas in a Scenario — never for live data. */
  static hypothetical(lat: number, lng: number): Pin {
    return new Pin(lat, lng)
  }

  /**
   * Rebuild a Pin that was already validated, across a serialization boundary
   * (server to browser). Not a way in for raw coordinates: a snapshot only
   * contains a pin because one was constructed from a trusted geocode.
   */
  static restore(lat: number, lng: number): Pin {
    return new Pin(lat, lng)
  }

  static inServiceArea(lat: number, lng: number): boolean {
    const b = ROUTING_POLICY.serviceBounds
    return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng
  }

  /** Great-circle miles. The one distance function in the domain. */
  distanceTo(other: Pin): number {
    const R = 3958.8
    const rad = Math.PI / 180
    const dLat = (other.lat - this.lat) * rad
    const dLng = (other.lng - this.lng) * rad
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.lat * rad) * Math.cos(other.lat * rad) * Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }

  equals(other: Pin): boolean {
    return this.lat === other.lat && this.lng === other.lng
  }
}

/**
 * One hop between two quotas: road miles and estimated drive minutes. Made by
 * the DriveMatrix, never by hand — the matrix is the one measurer of legs.
 */
export class Leg {
  private constructor(
    readonly fromQuotaId: string,
    readonly toQuotaId: string,
    readonly miles: number,
    readonly minutes: number,
  ) {}

  static of(fromQuotaId: string, toQuotaId: string, miles: number, minutes: number): Leg {
    return new Leg(fromQuotaId, toQuotaId, Math.round(miles * 10) / 10, Math.round(minutes * 10) / 10)
  }
}

/** Robust centre of a set of pins — median, so one bad pin cannot drag it. */
export function medianCentre(pins: readonly Pin[]): Pin | null {
  if (pins.length === 0) return null
  const mid = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  return Pin.hypothetical(mid(pins.map((p) => p.lat)), mid(pins.map((p) => p.lng)))
}

/**
 * Anything that can answer "is this pin inside me". Two shapes implement it: a
 * drawn circle, and a polygon boundary. Selection does not care which.
 */
export interface Region {
  contains(pin: Pin): boolean
}

/**
 * A circle drawn on the map: a centre and a radius in miles. Containment is
 * the haversine distance a Pin already knows how to compute, so this shape
 * needs no geometry of its own — which is why it is the cheap one to draw.
 */
export class Circle implements Region {
  private constructor(
    readonly centre: Pin,
    readonly radiusMi: number,
  ) {}

  static of(centre: Pin, radiusMi: number): Circle {
    if (!(radiusMi > 0)) throw new Error("a circle needs a positive radius")
    return new Circle(centre, radiusMi)
  }

  /**
   * The circle whose diameter runs from `a` to `b` — both land on the
   * perimeter, and the centre is the midpoint. This is the shape you get when
   * one point is pinned and the other is dragged: the anchor stays put on the
   * edge while the circle grows away from it.
   */
  static acrossDiameter(a: Pin, b: Pin): Circle {
    return Circle.of(
      Pin.hypothetical((a.lat + b.lat) / 2, (a.lng + b.lng) / 2),
      a.distanceTo(b) / 2,
    )
  }

  contains(pin: Pin): boolean {
    return this.centre.distanceTo(pin) <= this.radiusMi
  }

  /**
   * The outline, for drawing. Lives here rather than in the view so the
   * miles-per-degree conversion has one home — the repo already had that
   * constant loose in three places.
   */
  ring(steps = 72): { lat: number; lng: number }[] {
    const latDelta = this.radiusMi / MILES_PER_DEGREE_LAT
    const cos = Math.cos((this.centre.lat * Math.PI) / 180)
    const lngDelta = latDelta / Math.max(cos, 1e-6)
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = (2 * Math.PI * i) / steps
      return {
        lat: this.centre.lat + latDelta * Math.sin(t),
        lng: this.centre.lng + lngDelta * Math.cos(t),
      }
    })
  }
}

/** Earth's radius (3958.8 mi) times pi/180 — one degree of latitude. */
const MILES_PER_DEGREE_LAT = (3958.8 * Math.PI) / 180

/**
 * A closed region drawn on a map — the value object the model already assumed
 * when it said a Route area's boundary is a value object and membership stays
 * derived (point-in-polygon on the Pin).
 *
 * This one is unnamed and unstored: drawn to make a selection, used, discarded.
 * A Route area would be an entity holding one of these; a lasso is the same
 * geometry without the identity.
 */
export class Boundary implements Region {
  private constructor(readonly points: readonly { lat: number; lng: number }[]) {}

  /** Needs three corners to enclose anything; the ring closes implicitly. */
  static of(points: readonly { lat: number; lng: number }[]): Boundary {
    if (points.length < 3) throw new Error("a boundary needs at least three points")
    return new Boundary(points.map((p) => ({ lat: p.lat, lng: p.lng })))
  }

  /**
   * Ray casting: count how many edges a ray due east from the pin crosses.
   * Odd means inside. Handles concave shapes, which a bounding box would not —
   * and a lasso drawn around a coastline is always concave.
   */
  contains(pin: Pin): boolean {
    let inside = false
    const n = this.points.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = this.points[i]
      const b = this.points[j]
      const straddles = a.lat > pin.lat !== b.lat > pin.lat
      if (!straddles) continue
      const crossingLng = ((b.lng - a.lng) * (pin.lat - a.lat)) / (b.lat - a.lat) + a.lng
      if (pin.lng < crossingLng) inside = !inside
    }
    return inside
  }
}
