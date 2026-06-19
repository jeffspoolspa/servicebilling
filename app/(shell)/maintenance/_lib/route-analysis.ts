import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Route-analysis query layer, backed by the public.v_route_* analytical views
 * (distinct from the operational maintenance.v_* context views in ./views.ts).
 *
 * task_schedules is routing-only; v_route_stops is the routing spine: one row per
 * active slot, joined to the slot's pinned service_location geocode, the tech, and
 * the customer. The view owns the geography:
 *   - geo_trusted     — coordinate is rooftop-confirmed (geocode_status=ok AND place_id).
 *                       Untrusted coords (stale points on never-resolved addresses) are
 *                       never used for distance/centroid math.
 *   - nearest_office  — closest office by a robust median center over trusted coords.
 *   - is_cross_office — a trusted, office-assigned stop whose nearest office is clearly
 *                       (>8mi) closer than its assigned office: a real misassignment.
 */

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
  place_id: string | null
  geo_trusted: boolean
  office_center_mi: number | null
  nearest_office: string | null
  nearest_office_mi: number | null
  is_cross_office: boolean
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
