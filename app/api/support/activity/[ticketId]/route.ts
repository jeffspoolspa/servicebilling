import { NextResponse } from "next/server"
import { refuseUnlessSupport } from "@/app/(shell)/support/_lib/guard"
import { ticketActivity } from "@/app/(shell)/support/_lib/views"

/** A READ — straight from the support view, never through the .NET API.
 *  Exists as a route only because the sheet fetches it after each command. */
export async function GET(req: Request, ctx: { params: Promise<{ ticketId: string }> }) {
  const refusal = await refuseUnlessSupport(req)
  if (refusal) return refusal
  return NextResponse.json(await ticketActivity((await ctx.params).ticketId))
}
