import { NextResponse } from "next/server"
import { authorize } from "@/lib/api/authorize"
import { searchCustomers } from "@/app/(shell)/support/_lib/views"

/** The typeahead behind "log a call". Reads the EXISTING Customers table —
 *  the support module owns no customer data and never will. */
export async function GET(req: Request) {
  if (!(await authorize(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const term = new URL(req.url).searchParams.get("q")?.trim() ?? ""
  if (term.length < 2) return NextResponse.json([])
  return NextResponse.json(await searchCustomers(term))
}
