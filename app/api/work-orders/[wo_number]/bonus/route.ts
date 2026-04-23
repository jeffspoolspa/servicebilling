import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

/**
 * POST /api/work-orders/[wo_number]/bonus
 * Body: { included: boolean | null }
 *
 * Toggle the bonus-inclusion override on a WO. Passing `null` clears the
 * override and reverts the WO back to its computed default (true iff it
 * has a QBO invoice classified as Service).
 *
 * Routed through the `public.set_wo_bonus_inclusion` SECURITY DEFINER
 * RPC so the anon key doesn't need broader UPDATE rights on work_orders.
 *
 * Slug name matches the other /api/work-orders/[wo_number]/* routes
 * (sync, skip, billable-override). Next.js rejects mixed slug names at
 * the same path level.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ wo_number: string }> },
) {
  const { wo_number: wo } = await params
  if (!wo) {
    return NextResponse.json({ error: "wo_number required" }, { status: 400 })
  }
  let body: { included?: boolean | null } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const included =
    body.included === true || body.included === false ? body.included : null

  const sb = createAnon("public")
  const { data, error } = await sb.rpc("set_wo_bonus_inclusion", {
    p_wo_number: wo,
    p_included: included,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (data !== true) {
    return NextResponse.json(
      { error: `work order ${wo} not found` },
      { status: 404 },
    )
  }
  return NextResponse.json({ status: "ok", wo, included })
}
