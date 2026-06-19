import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createInQbo } from "@/lib/qbo/write"
import { checkServiceArea, calculateMaintQuote, type Office, type MaintQuote } from "./quote"
import { estimateMaintChemicals } from "./chem-estimate"
import { sendEmail } from "@/lib/comms/server/resend"
import { sendSms } from "@/lib/comms/server/ringcentral"
import { leadQuoteTemplate, type LeadQuoteContext } from "@/lib/comms/templates"

// Pure pricing + service-area helpers live in ./quote (client-importable).
// Re-export so existing server-side imports from intake keep working.
export { checkServiceArea, calculateQuote, calculateMaintQuote } from "./quote"
export type { Office } from "./quote"

/**
 * The ONE lead-intake orchestrator. Both entry points call this:
 *   - the in-app internal form (app/(shell)/leads/actions.ts)
 *   - the external website, via POST /api/leads
 *
 * It is the in-repo replacement for the `website-lead-intake` Supabase edge
 * function — same recipe (search_accounts_by_contact → create_account /
 * update_account_contact → create_service_body → create_maintenance_lead),
 * same service-area + quote logic — PLUS a leader-correct QBO customer create
 * (createInQbo). The old chain created the QBO customer via sync-customer-qbo →
 * f/qbo/sync_customer_to_qbo, which is update-only and silently skipped brand-new
 * customers; createInQbo actually POSTs to QBO. See docs/flows/lead-intake-to-conversion/.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export interface LeadIntakeBody {
  body_type: "pool" | "spa" | "fountain"
  is_primary: boolean
  is_short_term_rental?: boolean
  is_inground?: boolean | null
  is_screened_in?: boolean | null
  chlorination_system?: string | null
  filter_type?: string | null
  has_auto_cleaner?: boolean | null
  has_dogs?: boolean | null
  pool_volume?: number | null
  access_instructions?: string | null
  special_instructions?: string | null
  service_street?: string | null
  service_city?: string | null
  service_state?: string | null
  service_zip?: string | null
}

export interface LeadIntakeInput {
  account: {
    first_name: string
    last_name: string
    email?: string | null
    phone?: string | null
    account_type?: "residential" | "commercial"
    billing_street: string
    billing_city: string
    billing_state?: string | null
    billing_zip: string
  }
  bodies: LeadIntakeBody[]
  lead: {
    source: string
    visits_per_week: number
    pool_condition: "good" | "needs_repair" | "green_pool"
    issue_description?: string | null
  }
  /** Explicit office override (internal form). When omitted, derived from billing_zip. */
  office?: Office
  /** Internal entry can serve out-of-area leads; the website cannot. */
  allow_out_of_area?: boolean
  /** How to resolve the customer. Default 'auto' (dedup + reuse on match). */
  customer_action?: "auto" | "use_existing" | "create_new"
  /** Required when customer_action='use_existing' — the matched Customers.id. */
  existing_customer_id?: number
  /**
   * Auto-send the quote to the customer on create (default true). Set false for
   * the staff-driven "Continue to onboarding" path, where we collect the card +
   * pool details immediately instead of emailing a quote.
   */
  notify?: boolean
}

export interface LeadIntakeResult {
  ok: boolean
  account_id?: number
  lead_id?: string
  quoted_per_visit?: number
  returning?: boolean
  qbo?: "created" | "deferred" | "skipped"
  /** Outcome of the auto-quote notification (never blocks lead creation). */
  notify?: { channel: "email" | "sms" | "none"; status: "sent" | "failed" | "skipped" }
  error?: string
}

function normalizePhone(input?: string | null): string | undefined {
  if (!input) return undefined
  const digits = input.replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : undefined
}

export async function submitLeadIntake(input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const sb = createSupabaseAdmin()
  const a = input.account
  const phone = normalizePhone(a.phone)
  const billingState = (a.billing_state || "GA").trim()
  const billingZip = a.billing_zip.trim().slice(0, 5)

  // Office: explicit override, else derive from ZIP. Reject out-of-area unless allowed.
  const area = checkServiceArea(billingZip)
  const office = input.office ?? area.office
  if (!office) {
    if (!input.allow_out_of_area) return { ok: false, error: "Out of service area" }
  }

  // 1. Resolve the customer: explicit use_existing / create_new, else auto-dedup.
  const action = input.customer_action ?? "auto"
  let accountId: number | null = null
  let primaryLocationId: number | null = null
  let returning = false

  async function refreshContact(id: number) {
    // Standard customer-edit RPC (row-locked). Address omitted → unchanged.
    await sb.rpc("update_customer", {
      p_account_id: id,
      p_first_name: a.first_name,
      p_last_name: a.last_name,
      p_email: a.email ?? null,
      p_phone: phone ?? null,
    })
  }

  if (action === "use_existing" && input.existing_customer_id) {
    accountId = input.existing_customer_id
    returning = true
    await refreshContact(accountId)
  } else if (action === "auto") {
    const dedupQuery = a.email || phone
    if (dedupQuery) {
      const { data: matches } = await sb.rpc("search_accounts_by_contact", { p_query: dedupQuery })
      if (Array.isArray(matches) && matches.length > 0) {
        accountId = matches[0].id as number
        returning = true
        await refreshContact(accountId)
      }
    }
  }
  // action === "create_new" → leave accountId null → create_account below.

  if (!accountId) {
    const { data: acct, error: acctErr } = await sb.rpc("create_account", {
      p_first_name: a.first_name,
      p_last_name: a.last_name,
      p_email: a.email ?? null,
      p_phone: phone ?? null,
      p_account_type: a.account_type ?? "residential",
      p_billing_street: a.billing_street,
      p_billing_city: a.billing_city,
      p_billing_state: billingState,
      p_billing_zip: billingZip,
      p_account_name: null,
      p_service_street: a.billing_street,
      p_service_city: a.billing_city,
      p_service_state: billingState,
      p_service_zip: billingZip,
    })
    if (acctErr) return { ok: false, error: `Account creation failed: ${acctErr.message}` }
    accountId = (acct.account_id ?? acct.id) as number
    primaryLocationId = (acct.location_id ?? null) as number | null
  }

  // 2. Resolve a primary service location for the bodies.
  if (!primaryLocationId) {
    const { data: existingLoc } = await sb
      .schema("public").from("service_locations")
      .select("id").eq("account_id", accountId).eq("is_primary", true)
      .order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (existingLoc?.id) {
      primaryLocationId = existingLoc.id as number
    } else {
      // ADR 005: route through the canonical address door, not a direct insert.
      const { data: locId, error: locErr } = await sb.rpc("upsert_service_location", {
        p_account_id: accountId,
        p_street: a.billing_street,
        p_city: a.billing_city,
        p_state: billingState,
        p_zip: billingZip,
        p_is_primary: false,
      })
      if (locErr) return { ok: false, error: `Location creation failed: ${locErr.message}` }
      primaryLocationId = locId as number
    }
  }

  // 3. Create the QBO customer for a brand-NEW account — leader-correct (Pattern D).
  //    Best-effort: the lead still gets created if QBO fails.
  let qbo: LeadIntakeResult["qbo"] = "skipped"
  if (!returning) {
    try {
      const r = await createInQbo("customer", buildCustomerBody(input), { localId: accountId })
      qbo = r.success ? "created" : "deferred"
    } catch {
      qbo = "deferred"
    }
  }

  // 4. Service bodies.
  for (const b of input.bodies) {
    const { error: bodyErr } = await sb.rpc("create_service_body", {
      p_account_id: accountId,
      p_location_id: primaryLocationId,
      p_body_type: b.body_type,
      p_is_primary: !!b.is_primary,
      p_is_short_term_rental: b.is_short_term_rental ?? false,
      p_is_inground: b.is_inground ?? null,
      p_is_screened_in: b.is_screened_in ?? null,
      p_chlorination_system: b.chlorination_system ?? null,
      p_filter_type: b.filter_type ?? null,
      p_vegetation_level: null,
      p_has_auto_cleaner: b.has_auto_cleaner ?? false,
      p_has_dogs: b.has_dogs ?? false,
      p_pool_volume: b.pool_volume ?? null,
      p_access_instructions: b.access_instructions ?? null,
      p_special_instructions: b.special_instructions ?? null,
    })
    if (bodyErr) return { ok: false, error: `Body creation failed: ${bodyErr.message}` }
  }

  // 5. Lead (with the computed quote — same calculateMaintQuote the form/website use,
  //    so the stored per-visit matches what the customer was shown).
  const primary = input.bodies.find((b) => b.is_primary) ?? input.bodies[0]
  const chemEstimates = await estimateMaintChemicals()
  const quote = calculateMaintQuote(
    { primaryBodyType: primary.body_type, additionalBodyCount: input.bodies.length - 1, visitsPerWeek: input.lead.visits_per_week },
    chemEstimates,
  )
  const perVisit = quote.perVisit
  const { data: leadData, error: leadErr } = await sb.rpc("create_maintenance_lead", {
    p_account_id: accountId,
    p_source: input.lead.source,
    p_office: office,
    p_quoted_per_visit: perVisit,
    p_visits_per_week: input.lead.visits_per_week,
    p_pool_condition: input.lead.pool_condition,
    p_issue_description: input.lead.issue_description ?? null,
    p_site_visit_required: (a.account_type === "commercial") ? true : null,
  })
  if (leadErr) return { ok: false, error: `Lead creation failed: ${leadErr.message}` }
  const leadId = (leadData.lead_id ?? leadData.id) as string

  // 6. Mirror to Airtable for office triage (best-effort) — reuses the submit-ticket edge fn.
  const ticketType = input.lead.pool_condition === "green_pool" ? "green_pool" : input.lead.pool_condition === "needs_repair" ? "equipment" : "maintenance"
  void sb.functions.invoke("submit-ticket", {
    body: {
      type: ticketType,
      firstName: a.first_name, lastName: a.last_name, email: a.email, phone: a.phone,
      address: a.billing_street, addressCity: a.billing_city, addressState: billingState, addressZip: billingZip,
      description: input.lead.issue_description ?? `Maintenance lead — $${perVisit}/visit. Office: ${office}.`,
      office, source: "lead-intake",
    },
  }).catch(() => {})

  // 7. Auto-send the quote to the customer (non-fatal). Prefer email when present
  //    and the Resend template is configured; otherwise fall back to SMS. Any
  //    failure is swallowed — the lead is already created.
  const notify: LeadIntakeResult["notify"] = (input.notify !== false && office)
    ? await notifyQuote({
        office, leadId, accountId,
        firstName: a.first_name, email: a.email ?? null, phone: a.phone ?? null,
        quote,
      })
    : { channel: "none", status: "skipped" }

  return { ok: true, account_id: accountId, lead_id: leadId, quoted_per_visit: perVisit, returning, qbo, notify }
}

const FREQUENCY_LABEL: Record<MaintQuote["frequencyKey"], string> = {
  biweekly: "bi-weekly", weekly: "weekly", twice_weekly: "twice-weekly",
}

// The customer-facing get-started page (hosts the onboarding wizard + the
// already-accepted status screen). Same base the Windmill cadence uses.
const GET_STARTED_URL = process.env.GET_STARTED_URL || "https://jeffspoolspa.github.io/perfectpools-redesign/get-started/"

/** Mint the card-collection token + build the onboarding link for a lead. Best-effort. */
async function buildOnboardLink(leadId: string, laborMonthly: number): Promise<string | undefined> {
  try {
    const sb = createSupabaseAdmin()
    const preAuthCents = laborMonthly > 0 ? Math.round(laborMonthly * 100) : null
    const { data, error } = await sb.rpc("create_card_collection_request", { p_lead_id: leadId, p_pre_auth_amount: preAuthCents })
    if (error) return undefined
    const res = data as Record<string, unknown> | null
    const token = res?.token as string | undefined
    if (!token) return undefined
    const sep = GET_STARTED_URL.includes("?") ? "&" : "?"
    return `${GET_STARTED_URL}${sep}token=${token}`
  } catch {
    return undefined
  }
}

/** Auto-send the quote to the customer. Returns the channel + status; never throws. */
async function notifyQuote(args: {
  office: Office; leadId: string; accountId: number
  firstName: string; email: string | null; phone: string | null
  quote: MaintQuote
}): Promise<LeadIntakeResult["notify"]> {
  const onboardLink = await buildOnboardLink(args.leadId, args.quote.laborMonthly)
  const ctx: LeadQuoteContext = {
    firstName: args.firstName,
    office: args.office,
    quote: args.quote,
    visitFrequencyLabel: FREQUENCY_LABEL[args.quote.frequencyKey],
    onboardLink,
  }
  const templateId = leadQuoteTemplate.resendTemplateId()
  try {
    if (args.email && templateId) {
      const r = await sendEmail({
        office: args.office, to: args.email,
        lead_id: args.leadId, customer_id: args.accountId,
        template: { id: templateId, variables: leadQuoteTemplate.variables(ctx) },
        template_name: leadQuoteTemplate.name,
        created_by: "system:lead-intake",
      })
      return { channel: "email", status: r.ok ? "sent" : "failed" }
    }
    if (args.phone) {
      const r = await sendSms({
        office: args.office, to: args.phone,
        lead_id: args.leadId, customer_id: args.accountId,
        body: leadQuoteTemplate.sms(ctx),
        template_name: leadQuoteTemplate.name,
        created_by: "system:lead-intake",
      })
      return { channel: "sms", status: r.ok ? "sent" : "failed" }
    }
    return { channel: "none", status: "skipped" }
  } catch {
    return { channel: args.email && templateId ? "email" : "sms", status: "failed" }
  }
}

/** Build the QBO Customer body from the intake account fields. */
function buildCustomerBody(input: LeadIntakeInput): Record<string, unknown> {
  const a = input.account
  const body: Record<string, unknown> = {
    DisplayName: `${a.last_name}, ${a.first_name}`.trim(),
    GivenName: a.first_name,
    FamilyName: a.last_name,
    Notes: `Created at lead intake (source=${input.lead.source})`,
    BillAddr: {
      Line1: a.billing_street,
      City: a.billing_city,
      CountrySubDivisionCode: (a.billing_state || "GA"),
      PostalCode: a.billing_zip,
    },
  }
  if (a.email) body.PrimaryEmailAddr = { Address: a.email }
  if (a.phone) body.PrimaryPhone = { FreeFormNumber: a.phone }
  return body
}
