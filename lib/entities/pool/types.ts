/**
 * Pool entity — a serviceable asset (pool, spa, water feature) at a service
 * location. Lives in public.* because it's cross-module: maintenance writes
 * service history; billing reads for line-item context; future asset module
 * will track equipment per pool.
 */

export type PoolKind = "pool" | "spa" | "water_feature"
export type PoolSurface = "plaster" | "vinyl" | "fiberglass" | "tile" | "pebble"
export type PoolSanitizer = "chlorine" | "salt" | "bromine" | "mineral"

export interface Pool {
  id: string
  service_location_id: number
  name: string | null
  kind: PoolKind | null
  gallons: number | null
  surface: PoolSurface | null
  sanitizer: PoolSanitizer | null
  active: boolean
  seasonal_close_from: string | null
  seasonal_close_to: string | null
  // External source-of-truth IDs
  skimmer_id: string | null
  ion_pool_id: string | null
  external_source: string | null
  notes: string | null
  created_at: string
  updated_at: string
}
