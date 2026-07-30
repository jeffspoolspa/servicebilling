import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Real drive times for one route's points → Google Routes computeRouteMatrix.
 *
 * One POST returns the full asymmetric N×N grid for the given points (office
 * first, then the stops in any order). The client folds the cells into the
 * DriveMatrix, which then prices every leg of that route with measured road
 * minutes instead of the haversine estimate. Keeps GOOGLE_MAPS_API_KEY
 * server-side; session-gated (internal app).
 *
 * Limits, per the adopted method: 625 elements per request (≤25 points — a
 * route with its office is well under), and a low per-minute quota that 429s
 * under bursts; the client treats a failure as "estimates stand", never blank.
 */

const KEY = process.env.GOOGLE_MAPS_API_KEY

interface Point {
  id: string
  lat: number
  lng: number
}

interface Cell {
  originIndex: number
  destinationIndex: number
  duration?: string
  distanceMeters?: number
  condition?: string
}

export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!KEY) return NextResponse.json({ error: "GOOGLE_MAPS_API_KEY not set" }, { status: 500 })

  const { points } = (await req.json()) as { points: Point[] }
  if (!Array.isArray(points) || points.length < 2 || points.length > 25) {
    return NextResponse.json({ error: "need 2–25 points" }, { status: 400 })
  }

  const waypoints = points.map((p) => ({
    waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
  }))
  const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      // The API rejects the call without a field mask naming what comes back.
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition",
    },
    body: JSON.stringify({ origins: waypoints, destinations: waypoints, travelMode: "DRIVE" }),
  })
  if (!res.ok) {
    const detail = await res.text()
    return NextResponse.json(
      { error: `routes api ${res.status}`, detail: detail.slice(0, 300) },
      { status: res.status === 429 ? 429 : 502 },
    )
  }

  const cells = (await res.json()) as Cell[]
  const legs: { fromId: string; toId: string; minutes: number; miles: number }[] = []
  for (const c of cells) {
    // Keep only real roads; impossible pairs simply stay estimated.
    if (c.condition !== "ROUTE_EXISTS" || !c.duration) continue
    if (c.originIndex === c.destinationIndex) continue
    const seconds = Number(c.duration.replace(/s$/, ""))
    if (!Number.isFinite(seconds)) continue
    legs.push({
      fromId: points[c.originIndex].id,
      toId: points[c.destinationIndex].id,
      minutes: Math.round((seconds / 60) * 10) / 10,
      miles: Math.round(((c.distanceMeters ?? 0) / 1609.34) * 10) / 10,
    })
  }
  // Own each measured leg permanently: the road between two fixed pins does
  // not change, so a leg bought once is never bought again. Pin snapshots ride
  // along as the invalidation key; a write failure never blocks the response.
  if (legs.length > 0) {
    const at = new Map(points.map((p) => [p.id, p]))
    const rows = legs.map((l) => ({
      from_id: l.fromId,
      to_id: l.toId,
      minutes: l.minutes,
      miles: l.miles,
      from_lat: at.get(l.fromId)!.lat,
      from_lng: at.get(l.fromId)!.lng,
      to_lat: at.get(l.toId)!.lat,
      to_lng: at.get(l.toId)!.lng,
      measured_at: new Date().toISOString(),
    }))
    const { error } = await sb.schema("maintenance").from("drive_legs").upsert(rows)
    if (error) console.warn("drive_legs persist failed:", error.message)
  }

  return NextResponse.json({ legs })
}

/**
 * The permanent matrix, for hydration on map open. The client drops any leg
 * whose stored pin no longer matches the quota's current pin (re-geocoded
 * pool), so a stale measurement can never price a route.
 */
export async function GET() {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { data, error } = await sb
    .schema("maintenance")
    .from("drive_legs")
    .select("from_id, to_id, minutes, miles, from_lat, from_lng, to_lat, to_lng")
    .range(0, 199999)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ legs: data ?? [] })
}
