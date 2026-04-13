import { NextResponse } from "next/server"
import { triggerScript } from "@/lib/windmill"

export async function POST() {
  const { jobId } = await triggerScript("f/service_billing/refresh_open_invoices")
  return NextResponse.json({ jobId, status: "triggered" })
}
