import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { getUserAccess } from "@/lib/auth/access"

/**
 * Who may touch the support surface. One place, so the page guard and the
 * four API routes cannot drift into different answers.
 *
 * Two ways in, same as everywhere else in this app: a signed-in user holding
 * the `support` module, or the operator token (a terminal driving the same
 * use cases). Anything else gets 401/403 and never reaches .NET.
 */
export async function refuseUnlessSupport(req: Request): Promise<NextResponse | null> {
  const caller = await authorize(req)
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (caller.viaToken) return null

  const access = await getUserAccess()
  if (!access?.has("support")) {
    return NextResponse.json({ error: "no access to module: support" }, { status: 403 })
  }
  return null
}
