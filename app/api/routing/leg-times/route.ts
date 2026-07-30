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
  return NextResponse.json({ legs })
}
