import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Address autocomplete proxy → Google Places Autocomplete (ADR 005).
 *
 * This IS the Google Maps type-ahead dropdown: it predicts the real, normalized address
 * and corrects human errors (Blvd→Cir, Sable→Sabal, Point→Pointe). No `types` restriction,
 * so it returns BOTH street addresses AND establishments/POIs — HOAs, marinas, condos,
 * communities (e.g. "Grand Harbor HOA") that aren't a numbered street address but are real,
 * pinnable places, exactly like Google Maps' own search. Returns prediction id (place_id) +
 * label only; the coordinate + canonical components are fetched on pick via
 * /api/places/details. Keeps GOOGLE_MAPS_API_KEY server-side. Session-gated (internal app).
 *
 * Pass ?session=<uuid> (same token to /details on pick) so Google bills the pair as one
 * Autocomplete session instead of per-keystroke.
 */

const KEY = process.env.GOOGLE_MAPS_API_KEY

interface Suggestion {
  id: string // Google place_id
  label: string // formatted description
}

export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ suggestions: [], error: "unauthorized" }, { status: 401 })
  if (!KEY) return NextResponse.json({ suggestions: [], error: "GOOGLE_MAPS_API_KEY not set" })

  const url = new URL(req.url)
  const q = (url.searchParams.get("q") || "").trim()
  const session = url.searchParams.get("session") || ""
  if (q.length < 3) return NextResponse.json({ suggestions: [] })

  const params = new URLSearchParams({
    input: q,
    key: KEY,
    components: "country:us",
    // no `types` restriction → addresses + establishments/POIs (HOAs, marinas, communities)
  })
  if (session) params.set("sessiontoken", session)

  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`)
    const data = (await r.json()) as {
      status?: string
      predictions?: { place_id: string; description: string }[]
    }
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return NextResponse.json({ suggestions: [], error: `google ${data.status}` })
    }
    const suggestions: Suggestion[] = (data.predictions ?? []).map((p) => ({
      id: p.place_id,
      label: p.description,
    }))
    return NextResponse.json({ suggestions })
  } catch {
    return NextResponse.json({ suggestions: [], error: "google fetch failed" })
  }
}
