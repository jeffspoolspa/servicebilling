import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { sendEmail } from "@/lib/comms/server/resend"
import { leadQuoteTemplate, type LeadQuoteContext } from "@/lib/comms/templates"
import { calculateMaintQuote } from "@/lib/leads/quote"
import { estimateMaintChemicals } from "@/lib/leads/chem-estimate"

/**
 * TEMP dev-only: fire a real templated lead-quote email to verify Resend wiring.
 * GET /api/comms/test-quote?to=you@example.com  (session-gated). Delete after testing.
 */
export async function GET(req: Request) {
  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })

  const to = new URL(req.url).searchParams.get("to")
  if (!to) return NextResponse.json({ ok: false, error: "pass ?to=email" }, { status: 400 })

  const templateId = leadQuoteTemplate.resendTemplateId()
  if (!templateId) return NextResponse.json({ ok: false, error: "RESEND_TEMPLATE_LEAD_QUOTE not set" })

  const chem = await estimateMaintChemicals()
  const quote = calculateMaintQuote({ primaryBodyType: "pool", additionalBodyCount: 0, visitsPerWeek: 1 }, chem)
  const ctx: LeadQuoteContext = {
    firstName: "Carter",
    office: "richmond_hill",
    quote,
    visitFrequencyLabel: "weekly",
    onboardLink: "https://jeffspoolspa.github.io/perfectpools-redesign/get-started/?token=test",
  }

  const result = await sendEmail({
    office: "richmond_hill",
    to,
    lead_id: "11b146ac-f93b-4ca0-ab96-73ed87dc4b32",
    template: { id: templateId, variables: leadQuoteTemplate.variables(ctx) },
    template_name: leadQuoteTemplate.name,
    created_by: "system:test-quote",
  })

  return NextResponse.json({ sentTo: to, templateId, variables: leadQuoteTemplate.variables(ctx), result })
}
