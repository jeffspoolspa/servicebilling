import { NextResponse } from "next/server"
import { refuseUnlessSupport } from "@/app/(shell)/support/_lib/guard"
import { searchCustomers } from "@/app/(shell)/support/_lib/views"

/** The typeahead behind "log a call". Reads the EXISTING Customers table —
 *  the support module owns no customer data and never will. */
export async function GET(req: Request) {
  const refusal = await refuseUnlessSupport(req)
  if (refusal) return refusal
  const term = new URL(req.url).searchParams.get("q")?.trim() ?? ""
  if (term.length < 2) return NextResponse.json([])
  return NextResponse.json(await searchCustomers(term))
}
