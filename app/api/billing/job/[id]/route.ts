import { NextResponse, type NextRequest } from "next/server"
import { getJobStatus } from "@/lib/windmill"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const status = await getJobStatus(id)
  return NextResponse.json(status)
}
