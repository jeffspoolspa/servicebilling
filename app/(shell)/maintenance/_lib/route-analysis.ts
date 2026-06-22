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
 *   - office          — the ROUTE office = the TECH's branch (a route is tech x day), ADR 007 §9.
 *   - customer_office — the CUSTOMER's own office (Customers.office_id, geography/override).
 *   - nearest_office  — closest CUSTOMER-office median center over trusted coords (geographic).
 *   - is_cross_office — customer_office <> route office. Structurally common where an office has
 *                       no tech of its own (its customers ride an adjacent office's route), so
 *                       it's informational, not an anomaly highlight.
 *   - far_from_route  — a trusted stop >25mi from the median center of its own (tech x day)
 *                       route: the sharpest wrong-address signal (e.g. a Sea Island pool
 *                       mislabeled to Savannah). nearest_mate_mi is displayed context.
 */

/** The home offices = split_part(branches.name, ',', 1), ADR 007. Order = north→south.
 *  A stop with no office is unresolved-address (no trusted coordinate). */
export const HOME_OFFICES = ["Savannah", "Richmond Hill", "Brunswick", "Saint Marys"] as const

export interface RouteStop {
  schedule_id: string
  tech_employee_id: string | null
  tech_name: string | null
  office: string | null
  customer_office: string | null
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
  route_mates: number | null
  route_center_mi: number | null
  nearest_mate_mi: number | null
  far_from_route: boolean
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
