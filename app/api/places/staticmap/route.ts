import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Static map image proxy → Mapbox Static Images. Keeps MAPBOX_TOKEN server-side:
 * the browser <img> hits this route, we geocode (if only an address is given),
 * fetch the rendered PNG from Mapbox, and stream the bytes back. Dark style to
 * match the app. Returns 404 (so the client <img> hides) when the token is unset
 * or the address can't be located.
 *
 * Query: ?q=<address>  OR  ?lat=&lng=   (+ optional w, h)
 */

const TOKEN = process.env.MAPBOX_TOKEN

export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return new Response(null, { status: 401 })
  if (!TOKEN) return new Response(null, { status: 404 })

  const params = new URL(req.url).searchParams
  const q = (params.get("q") || "").trim()
  const w = Math.min(Math.max(parseInt(params.get("w") || "600", 10) || 600, 100), 1280)
  const h = Math.min(Math.max(parseInt(params.get("h") || "150", 10) || 150, 80), 1280)
  let lat = parseFloat(params.get("lat") || "")
  let lng = parseFloat(params.get("lng") || "")

  // Geocode the address when no coords were supplied.
  if ((Number.isNaN(lat) || Number.isNaN(lng)) && q) {
    try {
      const g = await fetch(
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=us&limit=1&access_token=${TOKEN}`,
      )
      const gd = await g.json()
      const coords = gd?.features?.[0]?.geometry?.coordinates
      if (Array.isArray(coords)) {
        lng = coords[0]
        lat = coords[1]
      }
    } catch {
      return new Response(null, { status: 502 })
    }
  }
  if (Number.isNaN(lat) || Number.isNaN(lng)) return new Response(null, { status: 404 })

  const marker = `pin-s+38bdf8(${lng},${lat})`
  const mapUrl =
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${marker}/${lng},${lat},14/${w}x${h}@2x` +
    `?access_token=${TOKEN}&attribution=false&logo=false`

  try {
    const img = await fetch(mapUrl)
    if (!img.ok) return new Response(null, { status: img.status })
    const buf = await img.arrayBuffer()
    return new Response(buf, {
      headers: {
        "Content-Type": img.headers.get("content-type") || "image/png",
        "Cache-Control": "private, max-age=86400",
      },
    })
  } catch {
    return new Response(null, { status: 502 })
  }
}
