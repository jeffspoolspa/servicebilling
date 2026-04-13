import { NextResponse, type NextRequest } from "next/server"
import { triggerScript } from "@/lib/windmill"

export async function POST(request: NextRequest) {
  const body = await request.json()
  const { wo_number, wo_numbers, dry_run = false } = body

  if (!wo_number && !wo_numbers?.length) {
    return NextResponse.json({ error: "Provide wo_number or wo_numbers" }, { status: 400 })
  }

  const { jobId } = await triggerScript("f/service_billing/process_work_order", {
    wo_number,
    wo_numbers,
    dry_run,
  })

  return NextResponse.json({ jobId, status: "triggered" })
}
