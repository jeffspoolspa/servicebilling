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

/** One ticket's header row — the detail sheet loads its own data so it can
 *  be opened by id, whether from a row click or straight after creation. */
export async function ticketById(ticketId: string): Promise<TicketRow | null> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.schema("support").from("v_ticket_queue")
    .select("*").eq("ticket_id", ticketId).maybeSingle()
  if (error) throw new Error(`ticket: ${error.message}`)
  return (data as TicketRow) ?? null
}

export async function ticketActivity(ticketId: string): Promise<ActivityEntry[]> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.schema("support").from("v_ticket_activity")
    .select("*").eq("ticket_id", ticketId).order("at")
  if (error) throw new Error(`ticket activity: ${error.message}`)
  return (data ?? []) as ActivityEntry[]
}

export interface CustomerPanel {
  qbo_customer_id: string
  display_name: string | null
  phone: string | null
  email: string | null
  normalized_address: string | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  account_type: string | null
  balance: number | null
}

/**
 * The customer, for DISPLAY beside a ticket. A read model, not an entity:
 * the support module owns no customer data and changes none of it, so this
 * is a query returning a DTO rather than anything the domain knows about.
 *
 * When editing arrives it will NOT write here — it will go through QBO,
 * which owns the record, and the change comes back on the sync.
 */
export async function customerPanel(qboCustomerId: string): Promise<CustomerPanel | null> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.from("Customers")
    .select("qbo_customer_id, display_name, phone, email, normalized_address, street, city, state, zip, account_type, balance")
    .eq("qbo_customer_id", qboCustomerId).maybeSingle()
  if (error) throw new Error(`customer panel: ${error.message}`)
  return (data as CustomerPanel) ?? null
}

/** This customer's OTHER open tickets — the duplicate-ticket check, and the
 *  context someone needs before promising anything on a call. */
export async function otherOpenTickets(
  customerId: string, exceptTicketId: string,
): Promise<TicketRow[]> {
  const sb = await createSupabaseServer()
  const { data, error } = await sb.schema("support").from("v_ticket_queue")
    .select("*").eq("customer_id", customerId).eq("status", "Open")
    .neq("ticket_id", exceptTicketId).order("opened_at", { ascending: false }).limit(10)
  if (error) throw new Error(`other tickets: ${error.message}`)
  return (data ?? []) as TicketRow[]
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
