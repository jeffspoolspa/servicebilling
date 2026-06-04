import { NextResponse, type NextRequest } from "next/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { requireApiAccess, AccessDeniedError } from "@/lib/auth/access"

/**
 * GET /api/leads/customer/[id]
 *
 * Returns the FULL (un-redacted) contact + address for a single customer the
 * staffer has chosen to attach a lead to. The dedup list (check-dedup) stays
 * redacted; revealing the full record is an explicit, per-customer action, so
 * we only ever expose one chosen record here.
 *
 * Session-gated (requireApiAccess("leads")). The id is the local Customers.id
 * (same id returned by search_accounts_by_contact / the dedup matches).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiAccess("leads")
  } catch (e) {
    const status = e instanceof AccessDeniedError ? e.status : 401
    return NextResponse.json({ error: "unauthorized" }, { status })
  }

  const { id } = await params
  const customerId = Number(id)
  if (!Number.isFinite(customerId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 })
  }

  const sb = createSupabaseAdmin()
  const { data, error } = await sb
    .from("Customers")
    .select("id, display_name, first_name, last_name, email, phone, account_type, street, city, state, zip, qbo_customer_id")
    .eq("id", customerId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 })

  return NextResponse.json({
    customer: {
      customer_id: data.id as number,
      display_name: (data.display_name as string) ?? null,
      first_name: (data.first_name as string) ?? "",
      last_name: (data.last_name as string) ?? "",
      email: (data.email as string) ?? "",
      phone: (data.phone as string) ?? "",
      account_type: (data.account_type as string) ?? null,
      street: (data.street as string) ?? "",
      city: (data.city as string) ?? "",
      state: (data.state as string) ?? "",
      zip: (data.zip as string) ?? "",
      has_qbo: !!data.qbo_customer_id,
    },
  })
}
