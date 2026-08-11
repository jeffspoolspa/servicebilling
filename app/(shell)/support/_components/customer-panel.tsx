"use client"

import { Mail, MapPin, Phone, TicketIcon, UserRound } from "lucide-react"
import { Pill } from "@/components/ui/pill"
import type { CustomerPanel, TicketRow } from "../_lib/views"

/**
 * The customer, on their own card under the ticket header. The ticket carries
 * a customer id and NOTHING else — every word on this card, the name included,
 * comes from looking that id up.
 *
 * Laid out to GROW: each attribute is one <Attribute> line, so adding work
 * orders, linked calls, or the service plan later is a line, not a re-layout.
 *
 * READ ONLY, deliberately. This module owns no customer data — when editing
 * arrives it will write through QBO, which owns the record, and the change
 * comes back on the sync. Nothing here will ever write the Customers table.
 */
export function CustomerCard({
  customer, others, onOpenTicket,
}: {
  customer: CustomerPanel | null
  others: TicketRow[]
  onOpenTicket: (ticketId: string) => void
}) {
  const address = [
    customer?.normalized_address ?? customer?.street,
    [customer?.city, customer?.state].filter(Boolean).join(", "),
    customer?.zip,
  ].filter(Boolean).join(" ")

  return (
    <div className="mx-5 my-3 rounded-xl border border-line bg-white/[0.02]">
      {/* who */}
      <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
        <UserRound className="size-4 shrink-0 text-ink-mute" />
        <span className="truncate text-[13px] text-ink">
          {customer?.display_name ?? "(unknown customer)"}
        </span>
        {customer?.account_type && (
          <span className="text-[10.5px] text-ink-mute">{customer.account_type}</span>
        )}
        <span className="flex-1" />
        {customer?.balance != null && customer.balance > 0 && (
          <Pill tone="sun">${customer.balance.toFixed(2)} due</Pill>
        )}
      </div>

      {/* how to reach them, and where the pool is */}
      <div className="px-3.5 py-2">
        <Attribute icon={Phone} label="Phone" value={customer?.phone}
                   href={customer?.phone ? `tel:${customer.phone}` : null} />
        <Attribute icon={Mail} label="Email" value={customer?.email}
                   href={customer?.email ? `mailto:${customer.email}` : null} />
        <Attribute icon={MapPin} label="Service address" value={address || null} />
      </div>

      {others.length > 0 && (
        <div className="border-t border-line-soft px-3.5 py-2">
          <div className="pb-1 text-[10.5px] uppercase tracking-wide text-sun">
            {others.length} other open ticket{others.length === 1 ? "" : "s"}
          </div>
          {others.map((other) => (
            <button
              key={other.ticket_id}
              className="flex w-full items-center gap-2 py-1 text-left text-[12px] text-ink-dim hover:text-ink"
              onClick={() => onOpenTicket(other.ticket_id)}
            >
              <TicketIcon className="size-3.5 shrink-0 text-sun" />
              <span className="truncate">{other.subject}</span>
              <span className="flex-1" />
              <span className="shrink-0 text-[11px] text-ink-mute">
                {other.priority} · {other.age_days < 1 ? "today" : `${Math.floor(other.age_days)}d`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One line of the card. Adding an attribute is adding one of these. */
function Attribute({
  icon: Icon, label, value, href,
}: {
  icon: typeof Phone
  label: string
  value: string | null | undefined
  href?: string | null
}) {
  return (
    <div className="flex items-start gap-2 py-1 text-[12px]">
      <Icon className="mt-[3px] size-3.5 shrink-0 text-ink-mute" />
      <span className="w-28 shrink-0 text-ink-mute">{label}</span>
      {value ? (
        href ? (
          <a className="min-w-0 break-words text-ink-dim hover:text-ink" href={href}>{value}</a>
        ) : (
          <span className="min-w-0 break-words text-ink-dim">{value}</span>
        )
      ) : (
        <span className="text-ink-mute">—</span>
      )}
    </div>
  )
}
