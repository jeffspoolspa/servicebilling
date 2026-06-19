import "server-only"

/**
 * Resolve a raw service address (typed text, no Google pick) → a canonical
 * place_id + rooftop coordinate, server-side (ADR 005 / ADR 007).
 *
 * This is the non-form counterpart to the autocomplete dropdown: any path that
 * arrives with a raw address (lead intake, ION ingestion, the API) calls this to
 * pin the address up front instead of waiting for the nightly geocode backfill.
 *
 * It mirrors f/google_maps/geocode_service_locations.py exactly: strict Geocoding
 * first, accept ONLY a precise (ROOFTOP / RANGE_INTERPOLATED, non-partial) result
 * inside the service bbox; on a coarse/zero result fall back to a GUARDED Places
 * Find Place fuzzy match that is accepted only if the corrected address AGREES
 * with the input (same house number, fuzzy street, same city) and is itself a
 * rooftop. A guessed city/ZIP centroid is never accepted (the "magnet centroid"
 * trap). Returns ok | out_of_area | needs_review — never a wrong place_id.
 *
 * Keep SERVICE_BBOX and the agreement thresholds in sync with that Python and
 * with app/(shell)/maintenance/_lib/geo.ts.
 */

const KEY = process.env.GOOGLE_MAPS_API_KEY

export const SERVICE_BBOX = { minLat: 30.2, maxLat: 32.7, minLng: -82.4, maxLng: -80.6 } as const

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
  geocode_status: "ok"
}

export type ResolveResult =
  | { resolved: true; address: ResolvedAddress }
  | { resolved: false; reason: "out_of_area" | "needs_review" | "no_key" | "error" }

export interface RawAddress {
  street: string
  city?: string | null
  state?: string | null
  zip?: string | null
}

function inBbox(lat: number, lng: number): boolean {
  return (
    lat >= SERVICE_BBOX.minLat &&
    lat <= SERVICE_BBOX.maxLat &&
    lng >= SERVICE_BBOX.minLng &&
    lng <= SERVICE_BBOX.maxLng
  )
}

const ABBR: Record<string, string> = {
  ST: "STREET", DR: "DRIVE", RD: "ROAD", CT: "COURT", LN: "LANE",
  CIR: "CIRCLE", BLVD: "BOULEVARD", AVE: "AVENUE", HWY: "HIGHWAY",
  PKWY: "PARKWAY", PL: "PLACE", TRL: "TRAIL", WY: "WAY",
  N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST",
}

function norm(s: string | null | undefined): string {
  const up = (s ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ")
  return up.split(/\s+/).filter(Boolean).map((t) => ABBR[t] ?? t).join(" ").trim()
}

/** 1 − normalized Levenshtein distance; 1.0 == identical. Mirrors the Python _ratio. */
function ratio(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)))
    }
    prev = cur
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

interface GeocodeResult {
  place_id: string
  formatted_address: string
  geometry: { location: { lat: number; lng: number }; location_type: string }
  address_components: { long_name: string; short_name: string; types: string[] }[]
  partial_match?: boolean
}

function compOf(res: GeocodeResult) {
  const comp: Record<string, { long_name: string; short_name: string }> = {}
  for (const c of res.address_components ?? []) for (const t of c.types) comp[t] = c
  return {
    long: (t: string) => comp[t]?.long_name ?? null,
    short: (t: string) => comp[t]?.short_name ?? null,
  }
}

function toAddress(res: GeocodeResult): ResolvedAddress {
  const { long, short } = compOf(res)
  const num = long("street_number")
  const route = long("route")
  return {
    place_id: res.place_id,
    street: num && route ? `${num} ${route}` : route ?? res.formatted_address.split(",")[0],
    city: long("locality") ?? long("postal_town") ?? long("sublocality") ?? "",
    state: short("administrative_area_level_1") ?? "GA",
    zip: long("postal_code") ?? "",
    lat: res.geometry.location.lat,
    lng: res.geometry.location.lng,
    label: res.formatted_address,
    location_type: res.geometry.location_type,
    geocode_status: "ok",
  }
}

const isPrecise = (res: GeocodeResult) =>
  ["ROOFTOP", "RANGE_INTERPOLATED"].includes(res.geometry.location_type) && !res.partial_match

async function geocodeByPlaceId(placeId: string): Promise<GeocodeResult | null> {
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${KEY}`)
  const d = (await r.json()) as { status?: string; results?: GeocodeResult[] }
  return d.status === "OK" && d.results?.length ? d.results[0] : null
}

/** Guarded Find Place fuzzy fallback for mistyped addresses (port of fuzzy_resolve). */
async function fuzzyResolve(input: RawAddress): Promise<ResolvedAddress | null> {
  const clean = input.street.trim().replace(/^(\d+)([A-Za-z])/, "$1 $2") // "628LONDON" -> "628 LONDON"
  const query = [clean, input.city, input.state || "GA", input.zip].filter(Boolean).join(", ")
  const inNum = clean.match(/^\s*(\d+)/)?.[1] ?? null
  const inStreet = norm(clean.replace(/^\s*\d+/, ""))
  const inCity = norm(input.city)

  let res: GeocodeResult | null
  try {
    const fp = (await (
      await fetch(
        `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id&key=${KEY}`,
      )
    ).json()) as { candidates?: { place_id: string }[] }
    const cands = fp.candidates ?? []
    if (!cands.length) return null
    res = await geocodeByPlaceId(cands[0].place_id)
  } catch {
    return null
  }
  if (!res || !isPrecise(res)) return null

  const { long, short } = compOf(res)
  const candNum = long("street_number")
  const candCity = long("locality") ?? long("postal_town") ?? long("sublocality")
  // Agreement guard — the corrected address must be the SAME place as the input.
  if (!(inNum && candNum && inNum === candNum)) return null
  if (ratio(inStreet, norm(long("route"))) < 0.72) return null
  const ccN = norm(candCity)
  if (!(inCity && ccN && (ccN.includes(inCity) || inCity.includes(ccN) || ratio(inCity, ccN) >= 0.7))) return null
  void short
  return toAddress(res)
}

export async function resolveServiceAddress(input: RawAddress): Promise<ResolveResult> {
  if (!KEY) return { resolved: false, reason: "no_key" }
  if (!input.street?.trim()) return { resolved: false, reason: "needs_review" }

  const bounds = `${SERVICE_BBOX.minLat},${SERVICE_BBOX.minLng}|${SERVICE_BBOX.maxLat},${SERVICE_BBOX.maxLng}`
  const address = [input.street, input.city, input.state || "GA", input.zip].filter(Boolean).join(", ")

  let data: { status?: string; results?: GeocodeResult[] }
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${KEY}&components=country:US&bounds=${encodeURIComponent(bounds)}`,
    )
    data = await r.json()
  } catch {
    return { resolved: false, reason: "error" }
  }

  if (data.status === "OK" && data.results?.length) {
    const res = data.results[0]
    if (isPrecise(res)) {
      const { lat, lng } = res.geometry.location
      if (inBbox(lat, lng)) return { resolved: true, address: toAddress(res) }
      return { resolved: false, reason: "out_of_area" }
    }
    // Coarse (city/ZIP centroid) — try the guarded fuzzy fallback before flagging.
  } else if (data.status !== "ZERO_RESULTS") {
    return { resolved: false, reason: "error" }
  }

  const fz = await fuzzyResolve(input)
  if (!fz) return { resolved: false, reason: "needs_review" }
  if (!inBbox(fz.lat, fz.lng)) return { resolved: false, reason: "out_of_area" }
  return { resolved: true, address: fz }
}
