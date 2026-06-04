import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createInQbo } from "@/lib/qbo/write"

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

// ── Service area (ZIP → office). Ported from website-lead-intake. ────────────
const BRUNSWICK_ZIPS = new Set(["31520","31521","31522","31523","31524","31525","31527","31561","31568","31548","31558","31565","31569"])
const RICHMOND_HILL_ZIPS = new Set(["31324","31328","31405","31406","31407","31408","31409","31410","31411","31412","31414","31415","31416","31419","31421","31302","31312","31313","31314","31315","31316","31320","31321","31323","31326","31327","31329","31301","31305","31309","31319","31331","31333"])
const ST_MARYS_ZIPS = new Set(["31547","31558","31548"])

export type Office = "richmond_hill" | "brunswick" | "st_marys"

export function checkServiceArea(zip: string): { inArea: boolean; office: Office | null } {
  const z = (zip || "").trim().slice(0, 5)
  if (BRUNSWICK_ZIPS.has(z)) return { inArea: true, office: "brunswick" }
  if (ST_MARYS_ZIPS.has(z)) return { inArea: true, office: "st_marys" }
  if (RICHMOND_HILL_ZIPS.has(z)) return { inArea: true, office: "richmond_hill" }
  if (z.startsWith("31")) {
    const n = parseInt(z, 10)
    if (n >= 31300 && n <= 31599) return { inArea: true, office: "richmond_hill" }
  }
  return { inArea: false, office: null }
}

const BASE_PRICES: Record<string, number> = { pool: 50, spa: 45, fountain: 35 }
const ADDITIONAL_BODY_SURCHARGE = 10

export function calculateQuote(primaryBodyType: string, additionalBodyCount: number, visitsPerWeek: number) {
  const base = BASE_PRICES[primaryBodyType] ?? 50
  const perVisit = base + additionalBodyCount * ADDITIONAL_BODY_SURCHARGE
  const firstMonthsDeposit = perVisit * visitsPerWeek * 4
  return { perVisit, firstMonthsDeposit }
}

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
}

export interface LeadIntakeResult {
  ok: boolean
  account_id?: number
  lead_id?: string
  quoted_per_visit?: number
  returning?: boolean
  qbo?: "created" | "deferred" | "skipped"
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

  // 1. Dedup → reuse + refresh contact, else create the account.
  let accountId: number | null = null
  let primaryLocationId: number | null = null
  let returning = false

  const dedupQuery = a.email || phone
  if (dedupQuery) {
    const { data: matches } = await sb.rpc("search_accounts_by_contact", { p_query: dedupQuery })
    if (Array.isArray(matches) && matches.length > 0) {
      accountId = matches[0].id as number
      returning = true
      await sb.rpc("update_account_contact", {
        p_account_id: accountId,
        p_first_name: a.first_name,
        p_last_name: a.last_name,
        p_email: a.email ?? null,
        p_phone: phone ?? null,
      })
    }
  }

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
      const { data: newLoc, error: locErr } = await sb
        .schema("public").from("service_locations")
        .insert({ account_id: accountId, street: a.billing_street, city: a.billing_city, state: billingState, zip: billingZip, is_primary: false })
        .select("id").single()
      if (locErr) return { ok: false, error: `Location creation failed: ${locErr.message}` }
      primaryLocationId = newLoc.id as number
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

  // 5. Lead (with the computed quote).
  const primary = input.bodies.find((b) => b.is_primary) ?? input.bodies[0]
  const { perVisit } = calculateQuote(primary.body_type, input.bodies.length - 1, input.lead.visits_per_week)
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

  return { ok: true, account_id: accountId, lead_id: leadId, quoted_per_visit: perVisit, returning, qbo }
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
