import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { resolveServiceAddress } from "@/lib/places/resolve"

/**
 * Resolve a raw service address (typed text, no Google pick) → canonical place_id
 * + rooftop coordinate, or a needs_review / out_of_area verdict (ADR 007). The
 * server-side counterpart to /api/places/autocomplete + /details (the dropdown
 * pick path). Same resolver the lead-intake composer calls directly; exposed here
 * so the human-pick UI and the drain job can reuse one implementation.
 * Session-gated (internal app). Keeps GOOGLE_MAPS_API_KEY server-side.
 */
export async function POST(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ resolved: false, reason: "unauthorized" }, { status: 401 })

  let body: { street?: string; city?: string; state?: string; zip?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ resolved: false, reason: "bad_request" }, { status: 400 })
  }
  if (!body.street) return NextResponse.json({ resolved: false, reason: "needs_review" })

  const result = await resolveServiceAddress({
    street: body.street,
    city: body.city ?? null,
    state: body.state ?? null,
    zip: body.zip ?? null,
  })
  return NextResponse.json(result)
}
