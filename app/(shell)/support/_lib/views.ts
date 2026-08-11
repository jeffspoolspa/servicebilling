import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Reads come STRAIGHT from the support views — never through the .NET API.
 * Loading an aggregate to render a table row is the category error the
 * write/read split exists to prevent, and these views already carry the
 * customer name joined in the database.
 *
 * Writes go the other way: through /api/support/* to the .NET domain.
 */

export interface TicketRow {
  ticket_id: string
  customer_id: string
  customer: string | null
  subject: string
  channel: string
  priority: "Low" | "Medium" | "High" | "Critical"
  status: "Open" | "Resolved"
  opened_at: string
  opened_by: string
  resolved_at: string | null
  resolved_by: string | null
  age_days: number
  last_activity_at: string | null
  last_note: string | null
  note_count: number
  link_count: number
}

export interface ActivityEntry {
  ticket_id: string
  entry_id: string
  entry: "note" | "link"
  sub_kind: string
  at: string
  actor: string
  body: string
  target_id: string | null
}

export async function listTickets(status?: "Open" | "Resolved"): Promise<TicketRow[]> {
  const sb = await createSupabaseServer()
  let query = sb.schema("support").from("v_ticket_queue").select("*")
  if (status) query = query.eq("status", status)
  const { data, error } = await query.order("opened_at", { ascending: false }).limit(500)
  if (error) throw new Error(`ticket queue: ${error.message}`)
  return (data ?? []) as TicketRow[]
}

export async function ticketActivity(ticketId: string): Promise<ActivityEntry[]> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.schema("support").from("v_ticket_activity")
    .select("*").eq("ticket_id", ticketId).order("at")
  if (error) throw new Error(`ticket activity: ${error.message}`)
  return (data ?? []) as ActivityEntry[]
}

/** The customer lookup for a new ticket — the existing table, no domain involved. */
export async function searchCustomers(term: string) {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.from("Customers")
    .select("qbo_customer_id, display_name")
    .not("qbo_customer_id", "is", null)
    .ilike("display_name", `%${term}%`)
    .order("display_name").limit(20)
  if (error) throw new Error(`customer search: ${error.message}`)
  return data ?? []
}
