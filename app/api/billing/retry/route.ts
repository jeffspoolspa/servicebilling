import { NextResponse, type NextRequest } from "next/server"
import { createAnon } from "@/lib/supabase/anon"

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { wo_number } = body

  if (!wo_number) {
    return NextResponse.json({ error: "Provide wo_number" }, { status: 400 })
  }

  const sb = createAnon("public")

  // Reset to needs_classification so the trigger re-fires on next ETL touch
  const { error } = await sb
    .from("work_orders")
    .update({
      billing_status: "needs_classification",
      needs_review_reason: null,
      billing_status_set_at: new Date().toISOString(),
    })
    .eq("wo_number", wo_number)
    .eq("billing_status", "needs_review")

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ status: "reset", wo_number })
}
