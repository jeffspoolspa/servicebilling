import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * The chemical-context REPORT: a clean, printable page (browser print ->
 * PDF) documenting the month's flagged chemical usage — the context Carter
 * attaches alongside the customer's invoice. Standalone route, outside the
 * app shell, so what prints is the report and nothing else.
 */

interface Visit {
  visit_id: string
  visit_date: string
  tech: string | null
  readings: Record<string, string>
  chems: { item: string; qty: number; cents: number | null }[]
}

export default async function BillingReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { customerId: rawId } = await params
  const { month } = await searchParams
  const customerId = parseInt(rawId, 10)
  if (!customerId || !month || !/^\d{4}-\d{2}$/.test(month)) notFound()

  const sb = await createSupabaseServer()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) notFound()

  const [findingsRes, visitsRes, custRes] = await Promise.all([
    sb
      .schema("billing")
      .from("v_findings_review")
      .select("message, cents, resolved_at, resolution")
      .eq("phase", "audit")
      .eq("customer_id", customerId)
      .eq("month", `${month}-01`),
    sb.rpc("maint_billing_review_visits", { p_customer_id: customerId, p_month: `${month}-01` }),
    sb.from("Customers").select("display_name").eq("id", customerId).limit(1),
  ])
  const findings = (findingsRes.data ?? []) as { message: string; cents: number | null; resolved_at: string | null; resolution: string | null }[]
  const visits = ((visitsRes.data ?? []) as Visit[]).sort((a, b) => a.visit_date.localeCompare(b.visit_date))
  const name = (custRes.data?.[0] as { display_name?: string } | undefined)?.display_name ?? `Customer ${customerId}`

  const flaggedDates = new Set(findings.map((f) => f.message.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-15T12:00:00Z`),
  )
  const chemTotal = (v: Visit) => v.chems.reduce((s, c) => s + (c.cents ?? 0), 0)
  const monthChem = visits.reduce((s, v) => s + chemTotal(v), 0)
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`

  return (
    <main className="mx-auto max-w-[760px] px-8 py-10 text-[13px] leading-relaxed print:px-0 print:py-0 bg-white text-neutral-900 min-h-screen">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[20px] font-semibold">Chemical usage report</h1>
          <p className="text-neutral-600">
            {name} — {monthLabel}
          </p>
        </div>
        <a
          href="#"
          className="print:hidden text-[12px] px-3 py-1.5 rounded border border-neutral-300 text-neutral-700"
        >
          Use your browser&apos;s Print → Save as PDF
        </a>
      </div>

      <p className="mt-4">
        {visits.length} service visit{visits.length === 1 ? "" : "s"} this month; chemicals dispensed totalled{" "}
        <strong>{usd(monthChem)}</strong>. The visits below are itemized with the water readings taken and the
        chemicals added on each visit{flaggedDates.size > 0 ? "; elevated-usage visits are marked" : ""}.
      </p>

      <table className="w-full mt-6 border-collapse">
        <thead>
          <tr className="border-b-2 border-neutral-800 text-left">
            <th className="py-1.5 pr-2">Date</th>
            <th className="py-1.5 pr-2">Technician</th>
            <th className="py-1.5 pr-2">Chemicals added</th>
            <th className="py-1.5 pr-2">Readings</th>
            <th className="py-1.5 text-right">Chemicals</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => (
            <tr key={v.visit_id} className="border-b border-neutral-200 align-top">
              <td className="py-1.5 pr-2 whitespace-nowrap">
                {v.visit_date.slice(5)}
                {flaggedDates.has(v.visit_date.slice(0, 10)) && (
                  <span className="ml-1 text-[10px] font-semibold text-neutral-700">*</span>
                )}
              </td>
              <td className="py-1.5 pr-2">{v.tech ?? "—"}</td>
              <td className="py-1.5 pr-2">
                {v.chems.length === 0 ? "—" : v.chems.map((c) => `${c.item} × ${c.qty}`).join(", ")}
              </td>
              <td className="py-1.5 pr-2 text-neutral-600">
                {Object.entries(v.readings ?? {})
                  .map(([k, val]) => `${k} ${val}`)
                  .join(" · ") || "—"}
              </td>
              <td className="py-1.5 text-right whitespace-nowrap">{chemTotal(v) > 0 ? usd(chemTotal(v)) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-neutral-800 font-semibold">
            <td className="py-1.5" colSpan={4}>
              Total chemicals
            </td>
            <td className="py-1.5 text-right">{usd(monthChem)}</td>
          </tr>
        </tfoot>
      </table>

      {flaggedDates.size > 0 && (
        <p className="mt-3 text-[11px] text-neutral-600">
          * Visits marked with an asterisk had above-typical chemical usage for comparable pools; readings on those
          days show the water condition the treatment addressed.
        </p>
      )}
    </main>
  )
}
