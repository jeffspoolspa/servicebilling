import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { submitLeadIntake } from "@/lib/leads/intake"

/**
 * Public lead-intake endpoint — the ONE orchestrator for both the external
 * website and the in-app internal form (which calls submitLeadIntake directly).
 *
 * Payload mirrors the old `website-lead-intake` edge function ({account, bodies,
 * lead}) so the website repoints here with a URL + auth-header change only.
 *
 * Auth: a shared API key in `x-api-key` (env LEADS_INTAKE_API_KEY). Listed in
 * PUBLIC_ROUTES + the middleware early-exit so session auth is skipped; the key
 * check below is the real gate — same pattern as /api/webhooks.
 */

const bodySchema = z.object({
  account: z.object({
    first_name: z.string().trim().min(1),
    last_name: z.string().trim().min(1),
    email: z.string().trim().email().nullish(),
    phone: z.string().trim().nullish(),
    account_type: z.enum(["residential", "commercial"]).optional(),
    billing_street: z.string().trim().min(1),
    billing_city: z.string().trim().min(1),
    billing_state: z.string().trim().nullish(),
    billing_zip: z.string().trim().min(1),
  }).refine((a) => (a.email && a.email.length > 0) || (a.phone && a.phone.length > 0), {
    message: "account.email or account.phone is required",
  }),
  bodies: z.array(z.object({
    body_type: z.enum(["pool", "spa", "fountain"]),
    is_primary: z.boolean(),
    is_short_term_rental: z.boolean().optional(),
    is_inground: z.boolean().nullish(),
    is_screened_in: z.boolean().nullish(),
    chlorination_system: z.string().nullish(),
    filter_type: z.string().nullish(),
    has_auto_cleaner: z.boolean().nullish(),
    has_dogs: z.boolean().nullish(),
    pool_volume: z.number().nullish(),
    access_instructions: z.string().nullish(),
    special_instructions: z.string().nullish(),
  })).min(1),
  lead: z.object({
    source: z.string().optional(),
    visits_per_week: z.union([z.literal(0.5), z.literal(1), z.literal(2)]),
    pool_condition: z.enum(["good", "needs_repair", "green_pool"]),
    issue_description: z.string().nullish(),
  }),
  office: z.enum(["richmond_hill", "brunswick", "st_marys"]).optional(),
})

export async function POST(req: NextRequest) {
  const key = req.headers.get("x-api-key")
  if (!process.env.LEADS_INTAKE_API_KEY || key !== process.env.LEADS_INTAKE_API_KEY) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 })
  }

  const d = parsed.data
  const result = await submitLeadIntake({
    account: d.account,
    bodies: d.bodies,
    lead: { ...d.lead, source: d.lead.source ?? "website" },
    office: d.office,
  })

  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
