import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * POST /api/card-collection/resolve — identify a customer from their service
 * address, then mint a vault capture session for them.
 *
 * Module: docs/flows/card-on-file-collection/index.md
 * Auth: none (customer-facing; the enumeration guardrails are in the SQL)
 *
 * Tables touched:
 *   public.service_locations   [read]  via search_service_addresses
 *   public."Customers"         [read]  via search_service_addresses / get_collect_customer
 *
 * External APIs:
 *   - card vault: POST /functions/v1/mint-session
 *
 * Triggered by:
 *   - https://secure.jeffspoolspa.com/collect (the public card-on-file form)
 *
 * Why this exists:
 *   This is the domain half of the card-collection flow, and it lives HERE
 *   rather than in the vault on purpose.
 *
 *   The vault is a payments service: it takes a card, tokenizes it with QBO, and
 *   hands back a token. It was deliberately decoupled from this database (see
 *   card-vault commit 6babb96, "capture no longer reads the business DB", which
 *   dropped the cross-project Customers FK). Deciding WHICH customer a card
 *   belongs to is our business rule, not the payment processor's — a processor
 *   that knows what a "service address" is has stopped being a processor.
 *
 *   The first cut of this flow put the lookup inside the vault, because minting
 *   needs VAULT_SECRET_KEY and living inside the vault meant getting that key
 *   for free. That convenience is what dragged our schema across the boundary.
 *   Holding the key here is the fix, not the cost: minting a session IS the
 *   authority to attach a card to a customer, so the system that owns customer
 *   identity is the system that should hold it.
 */

const VAULT_URL = process.env.CARD_VAULT_FUNCTIONS_URL || "https://rjxhummrmyigngdqiuic.supabase.co"

// The vault page is a different origin by design — that separation is what keeps
// card fields out of this app. So it needs explicit CORS.
const ALLOWED_ORIGINS = new Set(
  (process.env.CARD_COLLECT_ALLOWED_ORIGINS ||
    "https://secure.jeffspoolspa.com")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : null
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) })
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get("origin"))
  const json = (body: unknown, status = 200) =>
    NextResponse.json(body, { status, headers: cors })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const sb = createSupabaseAdmin()

  if (body.action === "search") {
    const query = String(body.query ?? "")
    // Cheap pre-filter only. The real gate is search_service_addresses itself
    // (exact house number + >=3 letters of street, LIMIT 5, masked names) —
    // it has to be, because that function is reachable from PostgREST with the
    // public anon key regardless of what this route does.
    if (query.trim().length < 4) return json({ candidates: [] })

    const { data, error } = await sb.rpc("search_service_addresses", { p_query: query })
    if (error) return json({ error: "Lookup failed" }, 500)
    return json({ candidates: data ?? [] })
  }

  if (body.action === "select") {
    const customerId = Number(body.customer_id)
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return json({ error: "Invalid selection" }, 400)
    }

    // Re-resolve server-side. The browser sends an id and nothing else, so the
    // qbo_customer_id a card ends up bound to always comes from this database.
    const { data, error } = await sb.rpc("get_collect_customer", { p_customer_id: customerId })
    if (error) return json({ error: "Lookup failed" }, 500)
    const row = (Array.isArray(data) ? data[0] : data) as
      | { customer_id: number; masked_name: string; qbo_customer_id: string; street: string | null; city: string | null }
      | undefined
    if (!row) return json({ error: "That account could not be found." }, 404)

    const secret = process.env.VAULT_SECRET_KEY
    if (!secret) {
      return json(
        { error: "Card entry is not configured. Please call the office." },
        503,
      )
    }

    const mint = await fetch(`${VAULT_URL}/functions/v1/mint-session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: row.customer_id,
        qbo_customer_id: row.qbo_customer_id,
        customer_name: row.masked_name,
        kind: "link",
      }),
    })
    const minted = (await mint.json().catch(() => ({}))) as Record<string, unknown>
    if (!mint.ok || !minted.capture_session) {
      return json({ error: "Could not start card entry. Please try again." }, 502)
    }

    return json({
      capture_session: minted.capture_session,
      expires_at: minted.expires_at,
      masked_name: row.masked_name,
      street: row.street,
      city: row.city,
    })
  }

  return json({ error: "Unknown action" }, 400)
}
