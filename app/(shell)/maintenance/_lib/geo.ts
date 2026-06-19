import { createSupabaseServer } from "@/lib/supabase/server"
import { listRouteStops, type TaskScheduleContextRow } from "./views"

/**
 * Geocode-quality layer for routes.
 *
 * Coordinates are resolved per service (pool) location: the
 * maintenance.v_* views expose service_location_latitude/longitude from
 * public.service_locations (the geocode of the actual pool address). During the
 * transition — while not every service_location has been geocoded yet — we fall
 * back to the legacy account-level public."Customers".latitude/longitude (keyed
 * by Customers.id = the view's customer_id) when the service-location coord is
 * null. Once the service_locations geocode backfill is complete the fallback is
 * dead weight and can be removed.
 *
 * Either way the routing tooling only READS coordinates and tags each stop with
 * a quality flag; it never tries to "fix" geocoding itself (that's the
 * f/google_maps service-location geocoding pipeline's job).
 *
 * Flags:
 *   - missing         : no lat/lng on either the service location or the customer
 *   - out_of_region   : geocoded outside the SE-GA / NE-FL service area (bad geocode)
 *   - far_from_route  : in-region but >25 mi from its (tech, day) route centroid
 *                       (suspicious — likely a bad geocode or a mis-assigned stop)
 *   - ok              : inside region and near its route
 */

export const SERVICE_BBOX = { minLat: 30.2, maxLat: 32.7, minLng: -82.4, maxLng: -80.6 } as const
const FAR_FROM_ROUTE_MI = 25

export type GeoFlag = "ok" | "missing" | "out_of_region" | "far_from_route"

export interface CustomerGeo {
  latitude: number | null
  longitude: number | null
  state: string | null
  zip: string | null
}

export interface RouteStopGeo extends TaskScheduleContextRow {
  latitude: number | null
  longitude: number | null
  state: string | null
  zip: string | null
  geo_flag: GeoFlag
  dist_from_centroid_mi: number | null
}

export function inServiceRegion(lat: number, lng: number): boolean {
  return (
    lat >= SERVICE_BBOX.minLat &&
    lat <= SERVICE_BBOX.maxLat &&
    lng >= SERVICE_BBOX.minLng &&
    lng <= SERVICE_BBOX.maxLng
  )
}

export function haversineMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLng = (bLng - aLng) * toRad
  const la1 = aLat * toRad
  const la2 = bLat * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Batch-fetch account-level coordinates from the legacy Customers table. */
async function fetchCustomerGeo(customerIds: Array<number | null>): Promise<Map<number, CustomerGeo>> {
  const supabase = await createSupabaseServer()
  const ids = [...new Set(customerIds.filter((x): x is number => x != null))]
  const out = new Map<number, CustomerGeo>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data } = await supabase
      .from("Customers")
      .select("id, latitude, longitude, state, zip")
      .in("id", chunk)
    for (const r of data ?? []) {
      out.set(Number(r.id), {
        latitude: r.latitude as number | null,
        longitude: r.longitude as number | null,
        state: (r.state as string | null) ?? null,
        zip: (r.zip as string | null) ?? null,
      })
    }
  }
  return out
}

/** Compute the unweighted centroid of a set of in-region points. */
function centroid(pts: Array<{ lat: number; lng: number }>): { lat: number; lng: number } | null {
  if (pts.length === 0) return null
  const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length
  const lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length
  return { lat, lng }
}

/** One route's stops, enriched with coordinates + a per-stop quality flag. */
export async function listRouteStopsGeo(
  techEmployeeId: string,
  dayOfWeek: number,
): Promise<RouteStopGeo[]> {
  const stops = await listRouteStops(techEmployeeId, dayOfWeek)
  const geo = await fetchCustomerGeo(stops.map((s) => s.customer_id))

  const enriched: RouteStopGeo[] = stops.map((s) => {
    const g = s.customer_id != null ? geo.get(s.customer_id) : undefined
    // Trust the service-location coordinate ONLY when it's rooftop-confirmed
    // (geocode_status='ok'); a needs_review/out_of_area/failed row may carry a stale,
    // wrong coordinate (ADR 005/007 invariant). Otherwise fall back to the account-level
    // Customers coordinate until the service_locations backfill is complete.
    const slOk = s.service_location_geocode_status === "ok"
    const lat = (slOk ? s.service_location_latitude : null) ?? g?.latitude ?? null
    const lng = (slOk ? s.service_location_longitude : null) ?? g?.longitude ?? null
    let flag: GeoFlag = "ok"
    if (lat == null || lng == null) flag = "missing"
    else if (!inServiceRegion(lat, lng)) flag = "out_of_region"
    return {
      ...s,
      latitude: lat,
      longitude: lng,
      state: g?.state ?? null,
      zip: s.service_location_zip ?? g?.zip ?? null,
      geo_flag: flag,
      dist_from_centroid_mi: null,
    }
  })

  const c = centroid(
    enriched
      .filter((e) => e.geo_flag === "ok" && e.latitude != null && e.longitude != null)
      .map((e) => ({ lat: e.latitude as number, lng: e.longitude as number })),
  )
  if (c) {
    for (const e of enriched) {
      if (e.geo_flag !== "ok" || e.latitude == null || e.longitude == null) continue
      const d = haversineMi(e.latitude, e.longitude, c.lat, c.lng)
      e.dist_from_centroid_mi = Math.round(d * 10) / 10
      if (d > FAR_FROM_ROUTE_MI) e.geo_flag = "far_from_route"
    }
  }
  return enriched
}

export interface GeocodeIssue {
  customer_id: number
  customer_name: string | null
  service_location_id: number | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  geo_flag: Exclude<GeoFlag, "ok">
  dist_from_route_mi: number | null
  routes: Array<{ tech_employee_id: string | null; tech_name: string | null; day_of_week: number }>
}

type RawScheduleGeoRow = {
  service_location_id: number
  customer_id: number | null
  customer_name: string | null
  tech_employee_id: string | null
  tech_name: string | null
  day_of_week: number | null
  service_location_street: string | null
  service_location_city: string | null
  service_location_zip: string | null
  service_location_latitude: number | null
  service_location_longitude: number | null
  service_location_geocode_status: string | null
}

const SEVERITY: Record<Exclude<GeoFlag, "ok">, number> = {
  missing: 3,
  out_of_region: 2,
  far_from_route: 1,
}

/**
 * Every active customer whose geocode is missing, out of region, or far from
 * a route they sit on — deduped to one row per customer (coords are
 * account-level), keeping the most severe flag and listing affected routes.
 */
export async function listGeocodeIssues(): Promise<GeocodeIssue[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .schema("maintenance")
    .from("v_task_schedules_with_context")
    .select(
      "service_location_id, customer_id, customer_name, tech_employee_id, tech_name, day_of_week, service_location_street, service_location_city, service_location_zip, service_location_latitude, service_location_longitude, service_location_geocode_status",
    )
    .eq("active", true)
    .eq("task_status", "active")
  if (error) throw error
  const rows = (data ?? []) as RawScheduleGeoRow[]
  const geo = await fetchCustomerGeo(rows.map((r) => r.customer_id))

  // Resolve each stop's coordinate: prefer the service-location geocode, fall
  // back to the account-level Customers coordinate until the backfill is done.
  const coordOf = (r: RawScheduleGeoRow): { lat: number | null; lng: number | null } => {
    const g = r.customer_id != null ? geo.get(r.customer_id) : undefined
    // Trust the service-location coordinate only when rooftop-confirmed (ADR 005/007).
    const slOk = r.service_location_geocode_status === "ok"
    return {
      lat: (slOk ? r.service_location_latitude : null) ?? g?.latitude ?? null,
      lng: (slOk ? r.service_location_longitude : null) ?? g?.longitude ?? null,
    }
  }

  // Per-(tech, day) centroids over in-region stops — needed for far-from-route.
  const routePts = new Map<string, Array<{ lat: number; lng: number }>>()
  for (const r of rows) {
    if (r.customer_id == null || r.day_of_week == null) continue
    const { lat, lng } = coordOf(r)
    if (lat == null || lng == null) continue
    if (!inServiceRegion(lat, lng)) continue
    const key = `${r.tech_employee_id}|${r.day_of_week}`
    const arr = routePts.get(key) ?? []
    arr.push({ lat, lng })
    routePts.set(key, arr)
  }
  const routeCentroid = new Map<string, { lat: number; lng: number } | null>()
  for (const [k, pts] of routePts) routeCentroid.set(k, centroid(pts))

  const byCustomer = new Map<number, GeocodeIssue>()
  for (const r of rows) {
    if (r.customer_id == null || r.day_of_week == null) continue
    const g = geo.get(r.customer_id)
    const { lat, lng } = coordOf(r)

    let flag: GeoFlag = "ok"
    let dist: number | null = null
    if (lat == null || lng == null) {
      flag = "missing"
    } else if (!inServiceRegion(lat, lng)) {
      flag = "out_of_region"
    } else {
      const c = routeCentroid.get(`${r.tech_employee_id}|${r.day_of_week}`)
      if (c) {
        const d = haversineMi(lat, lng, c.lat, c.lng)
        if (d > FAR_FROM_ROUTE_MI) {
          flag = "far_from_route"
          dist = Math.round(d)
        }
      }
    }
    if (flag === "ok") continue

    const route = { tech_employee_id: r.tech_employee_id, tech_name: r.tech_name, day_of_week: r.day_of_week }
    const existing = byCustomer.get(r.customer_id)
    if (!existing) {
      byCustomer.set(r.customer_id, {
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        service_location_id: r.service_location_id ?? null,
        street: r.service_location_street,
        city: r.service_location_city,
        state: g?.state ?? null,
        zip: r.service_location_zip ?? g?.zip ?? null,
        latitude: lat,
        longitude: lng,
        geo_flag: flag as Exclude<GeoFlag, "ok">,
        dist_from_route_mi: dist,
        routes: [route],
      })
    } else {
      if (!existing.routes.some((x) => x.tech_employee_id === route.tech_employee_id && x.day_of_week === route.day_of_week)) {
        existing.routes.push(route)
      }
      if (SEVERITY[flag as Exclude<GeoFlag, "ok">] > SEVERITY[existing.geo_flag]) {
        existing.geo_flag = flag as Exclude<GeoFlag, "ok">
        existing.dist_from_route_mi = dist
      }
    }
  }

  return [...byCustomer.values()].sort((a, b) => {
    const s = SEVERITY[b.geo_flag] - SEVERITY[a.geo_flag]
    if (s !== 0) return s
    return (a.customer_name ?? "").localeCompare(b.customer_name ?? "")
  })
}
