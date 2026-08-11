import { NextResponse } from "next/server"
import { refuseUnlessSupport } from "@/app/(shell)/support/_lib/guard"

/**
 * THE FORWARDER — the only bridge between this app and the .NET support API.
 *
 * One handler for every command: it takes the path after /api/support, adds
 * the shared secret, and passes the response back. Adding a use case in .NET
 * needs no change here.
 *
 * WHY IT EXISTS AT ALL rather than the browser calling .NET directly: the
 * secret must never reach client JavaScript, and .NET should not be exposed
 * to browsers (CORS, and a wider attack surface than one server calling
 * another). This is a backend-for-frontend, nothing more — no rules live
 * here, and if an `if` about tickets ever appears below, it belongs in a
 * use case in the domain.
 */
const API = process.env.DOTNET_API_URL
const SECRET = process.env.DOTNET_API_SECRET

async function forward(req: Request, path: string[]) {
  const refusal = await refuseUnlessSupport(req)
  if (refusal) return refusal

  if (!API || !SECRET) {
    // Say which, rather than failing as a generic 500 — a missing env var is
    // the most common cause and the least self-evident.
    return NextResponse.json(
      { error: `support API not configured (${!API ? "DOTNET_API_URL" : "DOTNET_API_SECRET"} missing)` },
      { status: 503 },
    )
  }

  // A PRESENT variable can still be unusable. Railway shows its host without
  // a scheme, and `fetch` on a scheme-less string throws ERR_INVALID_URL —
  // which surfaced as an HTML 500 the sheet could only report as "failed
  // (500)". Same check, same voice as the one above: name the cause.
  if (!URL.canParse(API)) {
    return NextResponse.json(
      { error: `support API not configured (DOTNET_API_URL is not an absolute URL: "${API}" — it needs the https:// scheme)` },
      { status: 503 },
    )
  }

  const body = req.method === "GET" ? undefined : await req.text()
  const upstream = await fetch(`${API}/${path.join("/")}`, {
    method: req.method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body,
  })

  const text = await upstream.text()
  return new NextResponse(text || null, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  })
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path)
}
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path)
}
