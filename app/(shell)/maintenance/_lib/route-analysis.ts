import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Route-analysis query layer, backed by the public.v_route_* analytical views
 * (distinct from the operational maintenance.v_* context views in ./views.ts).
 *
 * task_schedules is routing-only; v_route_stops is the routing spine: one row
 * per active slot, joined to the slot's pinned service_location geocode, the
 * tech, and the customer. office_outlier_mi is the slot's distance from its
 * OFFICE's centroid — the cross-office-leakage signal the territory map shows
 * (complementary to geo.ts's per-route far_from_route, which is relative to the
 * tech's route centroid, not the office).
 */

/** A stop is "in the wrong office's territory" past this many miles from its office centroid. */
export const OFFICE_OUTLIER_MI = 25

/** The three home offices (everything else is unassigned). Order = north→south. */
export const HOME_OFFICES = ["Richmond Hill", "Brunswick", "St. Marys"] as const

export interface RouteStop {
  schedule_id: string
  tech_employee_id: string | null
  tech_name: string | null
  office: string | null
  day_of_week: number | null
  sequence: number | null
  frequency: string | null
  task_id: string
  customer_id: number | null
  customer_name: string | null
  service_location_id: number | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  geocode_status: string | null
  office_outlier_mi: number | null
}

export interface RouteLoadRow {
  tech_employee_id: string | null
  tech_name: string | null
  day_of_week: number
  office: string | null
  stops: number
  ungeocoded: number
  avg_radius_mi: number | null
  max_radius_mi: number | null
}

export async function listRouteStopsAll(): Promise<RouteStop[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase.from("v_route_stops").select("*")
  if (error) throw error
  return (data ?? []) as unknown as RouteStop[]
}

export async function listRouteLoad(): Promise<RouteLoadRow[]> {
  const supabase = await createSupabaseServer()
  const { data, error } = await supabase
    .from("v_route_load")
    .select("*")
    .order("max_radius_mi", { ascending: false, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as unknown as RouteLoadRow[]
}

/** GA planar miles between two lat/lng (1deg lat = 69.0 mi, 1deg lng = 57.9 mi @ 31N). */
export function planarMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dy = (bLat - aLat) * 69.0
  const dx = (bLng - aLng) * 57.9
  return Math.sqrt(dx * dx + dy * dy)
}

/** Centroid (lat/lng) of each home office over its geocoded stops. */
export function officeCentroids(stops: RouteStop[]): Map<string, { lat: number; lng: number }> {
  const acc = new Map<string, { lat: number; lng: number; n: number }>()
  for (const s of stops) {
    if (!s.office || s.latitude == null || s.longitude == null) continue
    if (!(HOME_OFFICES as readonly string[]).includes(s.office)) continue
    const a = acc.get(s.office) ?? { lat: 0, lng: 0, n: 0 }
    a.lat += s.latitude
    a.lng += s.longitude
    a.n += 1
    acc.set(s.office, a)
  }
  const out = new Map<string, { lat: number; lng: number }>()
  for (const [o, a] of acc) out.set(o, { lat: a.lat / a.n, lng: a.lng / a.n })
  return out
}

export function isOutlier(s: RouteStop): boolean {
  return (
    s.office != null &&
    (HOME_OFFICES as readonly string[]).includes(s.office) &&
    s.office_outlier_mi != null &&
    s.office_outlier_mi > OFFICE_OUTLIER_MI
  )
}
