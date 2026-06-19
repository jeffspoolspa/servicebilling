import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Resolve a Google place_id → canonical address + coordinate (ADR 005). Called on pick
 * after autocomplete. street/city/state/zip are derived from Google's components — the
 * canonical-text rule (never the raw typed input). Coordinate is Google's; the map renders
 * it via Mapbox. Session-gated; pass ?session=<uuid> to pair with the autocomplete call.
 */

const KEY = process.env.GOOGLE_MAPS_API_KEY

export interface ResolvedAddress {
  place_id: string
  street: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  label: string
  location_type: string
}

export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!KEY) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 })

  const url = new URL(req.url)
  const placeId = url.searchParams.get("place_id") || ""
  if (!placeId) return NextResponse.json({ error: "place_id required" }, { status: 400 })

  // Geocode by place_id → canonical components + location_type + geometry.
  let g: {
    status?: string
    results?: {
      place_id: string
      formatted_address: string
      geometry: { location: { lat: number; lng: number }; location_type: string }
      address_components: { long_name: string; short_name: string; types: string[] }[]
    }[]
  }
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${KEY}`,
    )
    g = await r.json()
  } catch {
    return NextResponse.json({ error: "google fetch failed" }, { status: 502 })
  }
  if (g.status !== "OK" || !g.results?.length) {
    return NextResponse.json({ error: `google ${g.status}` }, { status: 502 })
  }

  const res = g.results[0]
  const comp: Record<string, { long_name: string; short_name: string }> = {}
  for (const c of res.address_components ?? []) for (const t of c.types) comp[t] = c
  const long = (t: string) => comp[t]?.long_name ?? null
  const short = (t: string) => comp[t]?.short_name ?? null
  const num = long("street_number")
  const route = long("route")

  const address: ResolvedAddress = {
    place_id: res.place_id,
    street: num && route ? `${num} ${route}` : (route ?? res.formatted_address.split(",")[0]),
    city: long("locality") ?? long("postal_town") ?? long("sublocality") ?? "",
    state: short("administrative_area_level_1") ?? "GA",
    zip: long("postal_code") ?? "",
    lat: res.geometry.location.lat,
    lng: res.geometry.location.lng,
    label: res.formatted_address,
    location_type: res.geometry.location_type,
  }

  return NextResponse.json({ address })
}
