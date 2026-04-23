import { NextResponse, type NextRequest } from "next/server"
import {
  getRevenueBreakdown,
  type Dimension,
  type Measure,
} from "@/lib/queries/revenue"

/**
 * POST /api/service/revenue/pivot
 * Body: { dimension, measure, startMonth, endMonth }
 *
 * Returns the pivot table for the Service Dashboard. Called client-side when
 * the dimension toggle (Location/Tech/Department), measure toggle ($/#), or
 * date-range picker changes. The initial page render uses `getRevenueBreakdown`
 * directly from the server component.
 */
export async function POST(req: NextRequest) {
  let body: {
    dimension?: Dimension
    measure?: Measure
    startMonth?: string
    endMonth?: string
  } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const dimension = body.dimension
  const measure = body.measure ?? "revenue"
  const startMonth = body.startMonth
  const endMonth = body.endMonth

  if (!dimension || !startMonth || !endMonth) {
    return NextResponse.json(
      { error: "dimension, startMonth, endMonth required" },
      { status: 400 },
    )
  }
  if (!["location", "tech", "department"].includes(dimension)) {
    return NextResponse.json({ error: "invalid dimension" }, { status: 400 })
  }
  if (!["revenue", "count"].includes(measure)) {
    return NextResponse.json({ error: "invalid measure" }, { status: 400 })
  }

  try {
    const result = await getRevenueBreakdown({
      dimension,
      measure,
      startMonth,
      endMonth,
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pivot failed" },
      { status: 500 },
    )
  }
}
