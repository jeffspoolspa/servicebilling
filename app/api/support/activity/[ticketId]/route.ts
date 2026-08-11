import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { ticketActivity } from "@/app/(shell)/support/_lib/views"

/** A READ — straight from the support view, never through the .NET API.
 *  Exists as a route only because the sheet fetches it after each command. */
export async function GET(req: Request, ctx: { params: Promise<{ ticketId: string }> }) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  return NextResponse.json(await ticketActivity((await ctx.params).ticketId))
}
