import { NextResponse, type NextRequest } from "next/server"
import { getMonthlyBonuses } from "@/lib/queries/bonuses"

/**
 * POST /api/service/bonuses
 * Body: { month: 'YYYY-MM' }
 *
 * Returns the monthly bonus breakdown for the five bonus-eligible techs.
 * Used by the MonthlyBonusesCard on the Service Dashboard when the user
 * changes the month picker.
 */
export async function POST(req: NextRequest) {
  let body: { month?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
    return NextResponse.json(
      { error: "month required as 'YYYY-MM'" },
      { status: 400 },
    )
  }
  try {
    const result = await getMonthlyBonuses(body.month)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "bonuses fetch failed" },
      { status: 500 },
    )
  }
}
