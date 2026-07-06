import { NextResponse, type NextRequest } from "next/server"
import { guardApi } from "@/lib/auth/api"

/**
 * GET /api/maintenance-billing/photo?key=3589/_Attachments/<cust>/<GUID>.jpg
 *
 * Full-size service-log photo click-through. Thumbnails are public S3 and
 * hot-linked directly; originals need a time-limited signed URL from ION's
 * ProEdge file service (no auth required on their end — verified 2026-07-06,
 * see docs/integrations/ion.md "Service-log photos"). Server-side fetch +
 * redirect keeps CORS out of the picture.
 */
const SIGNER = "https://ipc.proedgesoftware.com/v1/Containers/getSignedUrl"
const KEY_RE = /^\d+\/_Attachments\/\d+\/[A-F0-9-]+\.(jpg|jpeg|png|gif)$/i

export async function GET(req: NextRequest) {
  const guard = await guardApi("maintenance")
  if (guard instanceof NextResponse) return guard

  const key = req.nextUrl.searchParams.get("key") ?? ""
  if (!KEY_RE.test(key)) {
    return NextResponse.json({ error: "bad key" }, { status: 400 })
  }
  const serverName = key.split("/").pop()!
  const url = `${SIGNER}?key=${encodeURIComponent(key).replace(/%2F/g, "/")}` +
    `&server_name=${encodeURIComponent(serverName)}&local_name=${encodeURIComponent(serverName)}&redirect=false`
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  const body = (await r.text()).trim().replace(/^"|"$/g, "")
  if (!r.ok || !/^https:\/\//.test(body)) {
    return NextResponse.json({ error: "signing failed" }, { status: 502 })
  }
  return NextResponse.redirect(body)
}
