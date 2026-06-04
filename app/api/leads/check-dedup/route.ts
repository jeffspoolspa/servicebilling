import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { requireApiAccess, AccessDeniedError } from "@/lib/auth/access"

/**
 * Live dedup check for the internal lead form. The client posts the contact
 * value (email or phone) as it's typed; we look up matching customers and return
 * a REDACTED summary so staff can pick use-existing vs create-new.
 *
 * Session-gated (requireApiAccess("leads")) — the search RPC returns raw
 * phone/email/address, so we never hand the raw rows to the browser; we redact
 * here and only the opaque customer_id is used for the eventual attach.
 */

const schema = z.object({ query: z.string().trim().min(3) })

function redactPhone(phone: string | null): string | null {
  if (!phone) return null
  const d = phone.replace(/\D/g, "")
  return d.length >= 4 ? `•••-•••-${d.slice(-4)}` : null
}
function redactEmail(email: string | null): string | null {
  if (!email || !email.includes("@")) return null
  const [user, domain] = email.split("@")
  return `${user.slice(0, 1)}•••@${domain}`
}

export async function POST(req: NextRequest) {
  try {
    await requireApiAccess("leads")
  } catch (e) {
    const status = e instanceof AccessDeniedError ? e.status : 401
    return NextResponse.json({ error: "unauthorized" }, { status })
  }

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ matches: [] })

  const sb = createSupabaseAdmin()
  const { data, error } = await sb.rpc("search_accounts_by_contact", { p_query: parsed.data.query })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data as Array<Record<string, unknown>>) ?? []
  const matches = rows.slice(0, 5).map((r) => ({
    customer_id: r.id as number,
    display_name: (r.display_name as string) ?? `${r.last_name ?? ""}, ${r.first_name ?? ""}`.replace(/^,\s*|,\s*$/g, ""),
    account_type: (r.account_type as string) ?? null,
    has_qbo: !!r.qbo_customer_id,
    redacted_phone: redactPhone(r.phone as string | null),
    redacted_email: redactEmail(r.email as string | null),
  }))

  return NextResponse.json({ matches })
}
