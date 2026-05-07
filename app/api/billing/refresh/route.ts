import { NextResponse } from "next/server"
import { triggerScript } from "@/lib/windmill"
import { guardApi } from "@/lib/auth/api"

export async function POST() {
  const guard = await guardApi("service", { write: true })
  if (guard instanceof NextResponse) return guard
  const { jobId } = await triggerScript("f/service_billing/refresh_open_invoices")
  return NextResponse.json({ jobId, status: "triggered" })
}
