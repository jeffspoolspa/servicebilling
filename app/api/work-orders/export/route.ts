import { NextResponse, type NextRequest } from "next/server"
import { getAllWorkOrders, type WorkOrderFilters } from "@/lib/queries/work-orders"
import { guardApi } from "@/lib/auth/api"

/**
 * GET /api/work-orders/export
 *
 * Streams a CSV of every WO matching the same filter/sort the user has
 * applied to /work-orders. Same query string the page reads from
 * searchParams, so a "Download CSV" link can be built by appending the
 * page's URL search to this endpoint and getting a faithful export.
 *
 * Capped at 50k rows (see MAX_EXPORT_ROWS in lib/queries/work-orders.ts).
 * If the cap would be hit, returns 413 with a message asking the user
 * to narrow the filter.
 */

export const dynamic = "force-dynamic"

const COLUMNS = [
  "wo_number",
  "invoice_doc_number",
  "customer",
  "memo",
  "wo_type",
  "tech",
  "department",
  "office",
  "completed",
  "sub_total",
  "total_due",
  "invoice_balance",
  "invoice_qbo_class",
  "billing_status",
  "included_in_bonus",
  "bonus_override",
] as const

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  // Quote when the value contains a comma, quote, or newline. Escape
  // embedded quotes by doubling them per RFC 4180.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(request: NextRequest) {
  // Read access only — this is a read of data the user already sees on
  // the work-orders page. requireApiAccess('service') without write.
  const guard = await guardApi("service")
  if (guard instanceof NextResponse) return guard

  const sp = request.nextUrl.searchParams
  const filters: WorkOrderFilters = {
    month: sp.get("month")?.trim() || undefined,
    office: sp.get("office")?.trim() || undefined,
    tech: sp.get("tech")?.trim() || undefined,
    department: sp.get("department")?.trim() || undefined,
    techOther: sp.get("tech_other") === "1",
    ctaGroup: sp.get("cta_group") === "1",
    type: sp.get("type")?.trim() || undefined,
    q: sp.get("q")?.trim() || undefined,
    bonus:
      sp.get("bonus") === "true"
        ? true
        : sp.get("bonus") === "false"
          ? false
          : undefined,
  }
  const sort = sp.get("sort") ?? "completed"
  const dir = sp.get("dir") === "asc" ? "asc" : "desc"

  const { rows, truncated } = await getAllWorkOrders({
    filters, sortBy: sort, sortDir: dir,
  })

  if (truncated) {
    return NextResponse.json(
      {
        error:
          "Export exceeds the 50,000 row cap. Narrow your filter (month, office, tech, etc.) and try again.",
      },
      { status: 413 },
    )
  }

  // Build the CSV in-memory. 50k rows × ~16 fields × avg ~20 bytes ≈ 16MB
  // worst case — fine for a single response. If we ever genuinely need
  // larger we'd switch to a streamed Response with a ReadableStream.
  const lines: string[] = []
  lines.push(COLUMNS.join(","))
  for (const r of rows) {
    lines.push(
      [
        r.wo_number,
        r.invoice_doc_number,
        r.customer,
        r.invoice_memo,
        r.wo_type,
        r.tech,
        r.department,
        r.location,
        r.completed,
        r.sub_total,
        r.total_due,
        r.invoice_balance,
        r.invoice_qbo_class,
        r.billing_status,
        r.included_in_bonus,
        r.bonus_override,
      ]
        .map(csvEscape)
        .join(","),
    )
  }
  const csv = lines.join("\n") + "\n"

  // Nice filename — encode active filters so the user can tell exports
  // apart in their Downloads folder. Falls back to "work-orders" with
  // a timestamp when nothing's filtered.
  const tag =
    [filters.month, filters.office, filters.tech, filters.department]
      .filter(Boolean)
      .join("_") || new Date().toISOString().slice(0, 10)
  const filename = `work-orders_${tag.replace(/[^A-Za-z0-9_-]+/g, "-")}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
