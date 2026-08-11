import { NextResponse } from "next/server"
import { refuseUnlessSupport } from "@/app/(shell)/support/_lib/guard"
import { customerPanel, otherOpenTickets, ticketById } from "@/app/(shell)/support/_lib/views"

/**
 * Everything the detail sheet renders, in ONE request: the ticket, the
 * customer beside it, and their other open tickets. All reads, all from
 * views — no aggregate is loaded to draw a screen.
 */
export async function GET(req: Request, ctx: { params: Promise<{ ticketId: string }> }) {
  const refusal = await refuseUnlessSupport(req)
  if (refusal) return refusal

  const { ticketId } = await ctx.params
  const ticket = await ticketById(ticketId)
  if (!ticket) return NextResponse.json({ error: "not found" }, { status: 404 })

  const [customer, others] = await Promise.all([
    customerPanel(ticket.customer_id),
    otherOpenTickets(ticket.customer_id, ticketId),
  ])
  return NextResponse.json({ ticket, customer, others })
}
