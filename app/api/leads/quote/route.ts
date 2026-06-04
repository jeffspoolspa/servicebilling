import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { calculateMaintQuote } from "@/lib/leads/quote"
import { estimateMaintChemicals } from "@/lib/leads/chem-estimate"

/**
 * POST /api/leads/quote — the canonical maintenance quote, exposed for the
 * external website's form. Wraps the SAME calculateMaintQuote + estimateMaintChemicals
 * the internal form uses, so the website can't drift from in-app pricing.
 *
 * Auth: shared API key in `x-api-key` (env LEADS_INTAKE_API_KEY) — same key as
 * /api/leads. Listed in the middleware early-exit (/api/leads/*), so the key
 * check below is the real gate.
 */

const bodySchema = z.object({
  primaryBodyType: z.enum(["pool", "spa", "fountain"]),
  additionalBodyCount: z.number().int().min(0).max(20).default(0),
  visitsPerWeek: z.union([z.literal(0.5), z.literal(1), z.literal(2)]),
  // Optional override; omit to use the current month.
  month: z.number().int().min(1).max(12).optional(),
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

  const chem = await estimateMaintChemicals(d.month)
  const quote = calculateMaintQuote(
    { primaryBodyType: d.primaryBodyType, additionalBodyCount: d.additionalBodyCount, visitsPerWeek: d.visitsPerWeek },
    chem,
  )

  return NextResponse.json({ ok: true, quote })
}
