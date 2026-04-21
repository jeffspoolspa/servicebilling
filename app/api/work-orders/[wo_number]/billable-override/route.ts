import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

interface RouteContext {
  params: Promise<{ wo_number: string }>
}

/**
 * POST   /api/work-orders/[wo_number]/billable-override   { override: boolean }
 *   Pin billable to true or false, ignoring schedule_status from ION.
 *
 * DELETE /api/work-orders/[wo_number]/billable-override
 *   Clear the override — billable will re-derive from schedule_status.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { wo_number } = await context.params
  const body = await request.json().catch(() => ({}))
  const override = body?.override
  if (typeof override !== "boolean") {
    return NextResponse.json(
      { error: "body must contain { override: boolean }" },
      { status: 400 },
    )
  }
  const sb = createAnon("public")
  const { data, error } = await sb.rpc("set_wo_billable_override", {
    p_wo_number: wo_number,
    p_override: override,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "WO not found" }, { status: 404 })
  return NextResponse.json({ status: "set", wo_number, override })
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { wo_number } = await context.params
  const sb = createAnon("public")
  const { data, error } = await sb.rpc("clear_wo_billable_override", { p_wo_number: wo_number })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "WO not found" }, { status: 404 })
  return NextResponse.json({ status: "cleared", wo_number })
}
