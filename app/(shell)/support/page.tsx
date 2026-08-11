import { requireModuleAccess } from "@/lib/auth/access"
import { TicketsTable } from "./_components/tickets-table"
import { listTickets } from "./_lib/views"

export const metadata = { title: "Support · Tickets" }
export const dynamic = "force-dynamic"

/**
 * The queue. Reads support.v_ticket_queue DIRECTLY — the customer name is
 * joined in the database, so no aggregate is loaded and no second round
 * trip is made to render a row.
 *
 * Writes go the other way: the sheets post to /api/support/*, which
 * forwards to the .NET domain where the rules live.
 */
export default async function SupportPage() {
  await requireModuleAccess("support")
  const tickets = await listTickets()

  const open = tickets.filter((ticket) => ticket.status === "Open")
  const critical = open.filter((ticket) => ticket.priority === "Critical").length

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-[17px] text-ink">Tickets</h1>
        <span className="text-[11.5px] text-ink-mute">
          {open.length} open{critical > 0 && ` · ${critical} critical`}
        </span>
      </div>
      <TicketsTable rows={tickets} />
    </div>
  )
}
