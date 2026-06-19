import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * Lead read layer for the in-app /leads module.
 *
 * Reads go through the canonical Gen-2 RPCs (get_maintenance_leads /
 * get_maintenance_lead_by_id), which do the cross-schema joins server-side
 * (public.leads + Customers + maintenance.*). We use the service-role client
 * because the page guard (requireModuleAccess("leads")) is the real authz
 * boundary; never echo unrelated data from this client to the browser.
 *
 * See docs/entities/lead.md + docs/flows/lead-intake-to-conversion/index.md.
 */

export type LeadStatus =
  | "new" | "quoted" | "accepted" | "converted"
  | "expired" | "declined" | "disqualified" | "closed" | string

export interface LeadListRow {
  id: string
  account_id: number
  type: string | null
  lifecycle_state: "open" | "closed"
  status: LeadStatus
  source: string | null
  office: string | null
  quoted_per_visit: number | null
  first_months_deposit: number | null
  visits_per_week: number | null
  pool_condition: string | null
  contact_attempts: number
  created_at: string
  updated_at: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  email: string | null
  phone: string | null
  account_type: string | null
}

export interface ListLeadsParams {
  office?: string
  status?: string
  search?: string
  page: number
  perPage: number
}

export interface ListLeadsResult {
  rows: LeadListRow[]
  total: number
}

/**
 * Lead volume is low (tens, not thousands). We fetch all matching rows from the
 * RPC once (it has no total-count output) and paginate in memory. Revisit with a
 * dedicated count if lead counts ever grow large.
 */
export async function listLeads(params: ListLeadsParams): Promise<ListLeadsResult> {
  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("get_maintenance_leads", {
    p_office: params.office ?? null,
    p_status: params.status ?? null,
    p_search: params.search ?? null,
    p_limit: 1000,
    p_offset: 0,
  })
  if (error) throw new Error(`listLeads: ${error.message}`)

  const all = (data ?? []) as LeadListRow[]
  const total = all.length
  const start = (params.page - 1) * params.perPage
  return { rows: all.slice(start, start + params.perPage), total }
}

export interface LeadDetail {
  lead: Record<string, unknown> | null
  payment_on_file: boolean
  error?: string
}

export async function getLeadById(leadId: string): Promise<LeadDetail | null> {
  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("get_maintenance_lead_by_id", { p_lead_id: leadId })
  if (error) throw new Error(`getLeadById: ${error.message}`)
  if (!data) return null
  return data as unknown as LeadDetail
}

export interface LeadActivityRow {
  id: string
  activity_type: string
  description: string | null
  metadata: Record<string, unknown> | null
  created_by: string | null
  created_at: string
}

/** Activity timeline for a lead (maintenance.lead_activities, newest first). */
export async function getLeadActivities(leadId: string): Promise<LeadActivityRow[]> {
  const sb = createSupabaseAdmin().schema("maintenance")
  const { data, error } = await sb
    .from("lead_activities")
    .select("id, activity_type, description, metadata, created_by, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`getLeadActivities: ${error.message}`)
  return (data ?? []) as LeadActivityRow[]
}

export interface LeadTimelineItem {
  id: string
  at: string
  type: "email" | "text" | "other"
  title: string
}

/**
 * Communications-backed lead timeline, read from public.v_lead_timeline (which
 * unions communications + email/text bodies, keyed by lead_id). Feeds the reusable
 * ActivityTimeline component. Newest first.
 */
export async function getLeadTimeline(leadId: string): Promise<LeadTimelineItem[]> {
  const sb = createSupabaseAdmin()
  const { data, error } = await sb
    .from("v_lead_timeline")
    .select("at, event, title, source_id")
    .eq("lead_id", leadId)
    .order("at", { ascending: false })
  if (error) throw new Error(`getLeadTimeline: ${error.message}`)
  return (data ?? []).map((r: Record<string, unknown>) => {
    const event = String(r.event ?? "")
    const type: LeadTimelineItem["type"] = event.startsWith("email")
      ? "email"
      : event.startsWith("sms") || event.startsWith("text")
        ? "text"
        : "other"
    return {
      id: String(r.source_id),
      at: String(r.at),
      type,
      title: (r.title as string) || (type === "email" ? "Email" : type === "text" ? "Text message" : "Activity"),
    }
  })
}
